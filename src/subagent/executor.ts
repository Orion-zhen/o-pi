import { realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TokenCounterScope } from "../token-counter.js";
import { discoverAgents, formatAvailableAgents, resolveSubagentTools } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { exceedsTokenLimit, formatFileHandoff, formatResultForContext, persistResult } from "./output.js";
import { runPiProcess } from "./process.js";
import type {
	AgentDefinition,
	ExecutorContext,
	ExecutorOptions,
	ProcessRunOutput,
	ProcessRunProgress,
	SubagentConfig,
	SubagentDetails,
	SubagentMode,
	SubagentRunResult,
	SubagentTask,
	SubagentToolParams,
	SubagentToolResult,
	UsageStats,
} from "./types.js";

export class SubagentExecutionError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "SubagentExecutionError";
	}
}

/** 工具与 slash command 共用的执行入口。 */
export async function executeSubagent(params: SubagentToolParams, context: ExecutorContext, options: ExecutorOptions = {}): Promise<SubagentToolResult> {
	const config = await loadSubagentConfig(context.cwd);
	const discovery = discoverAgents(context.cwd, config);
	const mode = resolveMode(Array.isArray(params.tasks) ? params.tasks : []);
	const tokenScope: TokenCounterScope = context.currentModel === undefined ? {} : { modelId: context.currentModel };
	const runId = createRunId();
	let activeTasks: SubagentTask[] = Array.isArray(params.tasks) ? params.tasks : [];
	const detailsBase = (results: SubagentRunResult[]): SubagentDetails => ({ mode, runId, tasks: cloneTasks(activeTasks), results, warnings: discovery.warnings });

	try {
		const tasks = requireTasks(params.tasks);
		activeTasks = tasks;
		if (mode === "parallel") {
			if (tasks.length > config.maxParallelTasks) {
				throw new SubagentExecutionError(`Too many parallel tasks (${tasks.length}). Max is ${config.maxParallelTasks}.`);
			}
			const liveResults: Array<SubagentRunResult | undefined> = new Array(tasks.length);
			emitUpdate(context, detailsBase, compactResults(liveResults));
			const results = await mapWithConcurrency(tasks, config.maxConcurrency, async (task, index) => {
				const result = await executeOne(task, mode, runId, context, config, discovery.agents, (partial) => {
					liveResults[index] = partial;
					emitUpdate(context, detailsBase, compactResults(liveResults));
				});
				const persisted = await persistResult(result, { cwd: result.cwd, runId, index });
				liveResults[index] = persisted;
				emitUpdate(context, detailsBase, compactResults(liveResults));
				if (options.failFast === true && persisted.error !== undefined) throw new SubagentExecutionError(persisted.error);
				return persisted;
			});
			const success = results.filter((result) => result.error === undefined).length;
			const onlyResult = results[0];
			const text = results.length === 1 && onlyResult !== undefined
				? resultToContent(onlyResult, config, tokenScope)
				: [`Subagents: ${success}/${results.length} succeeded`, "", ...results.map((result) => `### ${result.agent}\n\n${resultToContent(result, config, tokenScope)}`)].join("\n");
			return { content: [{ type: "text", text }], details: detailsBase(results) };
		}
		const results: SubagentRunResult[] = [];
		let previous = "";
		for (let i = 0; i < tasks.length; i++) {
			const step = tasks[i];
			if (step === undefined) continue;
			const taskText = step.task.replace(/\{previous\}/g, previous);
			const result = await executeOne({ ...step, task: taskText }, mode, runId, context, config, discovery.agents, (partial) => {
				emitUpdate(context, detailsBase, [...results, partial]);
			});
			const persisted = await persistResult(result, { cwd: result.cwd, runId, index: i });
			results.push(persisted);
			emitUpdate(context, detailsBase, results);
			if (persisted.error !== undefined) {
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${persisted.agent}): ${persisted.error}` }],
					details: detailsBase(results),
				};
			}
			const output = persisted.output ?? "";
			previous = exceedsTokenLimit(output, Math.min(config.maxInlineOutputTokens, config.maxHandoffTokens), tokenScope)
				? formatFileHandoff(persisted)
				: output;
		}
		const last = results.at(-1);
		return { content: [{ type: "text", text: last === undefined ? "(no output)" : resultToContent(last, config, tokenScope) }], details: detailsBase(results) };
	} catch (error) {
		const available = formatAvailableAgents(discovery.agents);
		const text = `${errorMessage(error)}\nAvailable agents: ${available}`;
		return { content: [{ type: "text", text }], details: detailsBase([]) };
	}
}

export function resolveMode(tasks: readonly SubagentTask[]): SubagentMode {
	return tasks.some((task) => task.task.includes("{previous}")) ? "chain" : "parallel";
}

function requireTasks(tasks: SubagentTask[] | undefined): SubagentTask[] {
	if (tasks === undefined || tasks.length === 0) throw new SubagentExecutionError("tasks must not be empty.");
	return tasks;
}

async function executeOne(
	task: SubagentTask,
	mode: SubagentMode,
	runId: string,
	context: ExecutorContext,
	config: SubagentConfig,
	agents: AgentDefinition[],
	onProgress?: (result: SubagentRunResult) => void,
): Promise<SubagentRunResult> {
	const agent = agents.find((candidate) => candidate.name === task.agent);
	if (agent === undefined) throw new SubagentExecutionError(`Unknown agent "${task.agent}".`);
	const cwd = await resolveCwd(task.cwd ?? context.cwd, context.cwd);
	const tools = resolveTools(agent, config, context.registeredTools);
	const model = resolveModel(agent, config, context);
	await confirmIfNeeded(agent, task.task, cwd, tools, config, context);
	const maxAttempts = Math.max(1, (agent.retries ?? config.retries) + 1);
	let attempts = 0;
	let last: ProcessRunOutput | undefined;
	onProgress?.(runningResult({ runId, mode, agent, task: task.task, cwd, ...(model !== undefined ? { model } : {}), tools, attempts: 0 }));
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		attempts = attempt;
		last = await runPiProcess(
			{
				runId,
				mode,
				agent,
				task: task.task,
				cwd,
				...(model !== undefined ? { model } : {}),
				tools,
				timeoutMs: agent.timeoutMs ?? config.timeoutMs,
				attempt,
				maxAttempts,
			},
			{
				...(context.signal !== undefined ? { signal: context.signal } : {}),
				onUpdate: (progress) => {
					onProgress?.(runningResult({ runId, mode, agent, task: task.task, cwd, ...(model !== undefined ? { model } : {}), tools, attempts, progress }));
				},
			},
		);
		const failure = validateProcessOutput(last);
		if (failure === undefined) break;
		if (!shouldRetry(failure, last, attempt, maxAttempts, agent, config)) break;
		await delay(config.retryDelayMs, context.signal);
	}
	const output = last ?? emptyProcessOutput();
	const failure = validateProcessOutput(output);
	return {
		runId,
		mode,
		agent: agent.name,
		source: agent.source,
		task: task.task,
		cwd,
		...(model !== undefined ? { model } : {}),
		tools,
		attempts,
		exitCode: output.exitCode,
		...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
		...(failure !== undefined ? { error: failure } : {}),
		output: output.output,
		...(output.stderr !== "" ? { stderr: output.stderr } : {}),
		durationMs: output.durationMs,
		usage: output.usage,
		events: output.events,
	};
}

function resolveTools(agent: AgentDefinition, config: SubagentConfig, registeredTools: string[] | undefined): string[] {
	const tools = resolveSubagentTools(agent, config, registeredTools);
	if (tools.length === 0) {
		throw new SubagentExecutionError(`Agent "${agent.name}" has no usable tools after intersecting configured tools with registered tools.`);
	}
	return tools;
}

function resolveModel(agent: AgentDefinition, config: SubagentConfig, context: ExecutorContext): string | undefined {
	return config.agentOverrides[agent.name]?.model ?? agent.model ?? config.defaultModel ?? context.currentModel;
}

async function confirmIfNeeded(
	agent: AgentDefinition,
	task: string,
	cwd: string,
	tools: string[],
	config: SubagentConfig,
	context: ExecutorContext,
): Promise<void> {
	if (agent.source === "user" && agent.autoConfirm === true) return;
	const needsConfirm = config.confirmWriteAgents && tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash" || !["read", "grep", "find", "ls"].includes(tool));
	if (!needsConfirm) return;
	if (!context.hasUI || context.confirm === undefined) throw new SubagentExecutionError(`Agent "${agent.name}" needs write-capable tools but confirmation UI is unavailable.`);
	const approved = await context.confirm(
		"Run write-capable subagent?",
		[`Agent: ${agent.name}`, `Source: ${agent.source} (${agent.filePath})`, `cwd: ${cwd}`, `Tools: ${tools.join(", ")}`, "", task].join("\n"),
	);
	if (!approved) throw new SubagentExecutionError(`Canceled write-capable agent: ${agent.name}`);
}

async function resolveCwd(input: string, workspace: string): Promise<string> {
	const workspaceReal = await realpath(workspace);
	const raw = path.isAbsolute(input) ? input : path.join(workspaceReal, input);
	const target = await realpath(raw);
	const relative = path.relative(workspaceReal, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new SubagentExecutionError(`cwd escapes workspace: ${input}`);
	return target;
}

function validateProcessOutput(output: ProcessRunOutput): string | undefined {
	if (output.timedOut) return "subagent timed out";
	if (output.aborted) return "subagent aborted";
	if (output.exitCode !== 0) return `subagent exited with code ${output.exitCode}`;
	if (output.stopReason === "error" || output.stopReason === "aborted") return `subagent stopReason: ${output.stopReason}`;
	if (output.providerError !== undefined) return `provider error: ${truncateError(output.providerError)}`;
	if (output.error !== undefined) return output.error;
	if (output.output.trim() === "") return "empty output";
	if (output.parseErrors > 0 && output.output.trim() === "") return "JSON output could not be parsed";
	return undefined;
}

function shouldRetry(
	failure: string,
	output: ProcessRunOutput,
	attempt: number,
	maxAttempts: number,
	agent: AgentDefinition,
	config: SubagentConfig,
): boolean {
	if (attempt >= maxAttempts) return false;
	if (output.wrote || agent.hasWriteCapability) return false;
	if (failure === "subagent timed out") return config.retryOnTimeout;
	if (failure === "empty output") return config.retryOnEmptyOutput;
	return output.exitCode !== 0 || output.stopReason === "error" || output.providerError !== undefined;
}

function resultToContent(result: SubagentRunResult, config: SubagentConfig, tokenScope: TokenCounterScope): string {
	if (result.error !== undefined) return `${result.error}\n${truncateError(result.stderr ?? "")}`.trim();
	return formatResultForContext(result, config.maxInlineOutputTokens, tokenScope);
}

function emitUpdate(context: ExecutorContext, makeDetails: (results: SubagentRunResult[]) => SubagentDetails, results: SubagentRunResult[]): void {
	context.onUpdate?.({ content: [{ type: "text", text: `Subagents ${results.length} updated` }], details: makeDetails(results) });
}

function runningResult(input: {
	runId: string;
	mode: SubagentMode;
	agent: AgentDefinition;
	task: string;
	cwd: string;
	model?: string;
	tools: string[];
	attempts: number;
	progress?: ProcessRunProgress;
}): SubagentRunResult {
	const progress = input.progress;
	return {
		runId: input.runId,
		mode: input.mode,
		agent: input.agent.name,
		source: input.agent.source,
		task: input.task,
		cwd: input.cwd,
		...(input.model !== undefined ? { model: input.model } : {}),
		tools: input.tools,
		attempts: input.attempts,
		exitCode: -1,
		...(progress?.stopReason !== undefined ? { stopReason: progress.stopReason } : {}),
		...(progress?.error !== undefined ? { error: progress.error } : {}),
		...(progress !== undefined ? { output: progress.output } : {}),
		...(progress !== undefined && progress.stderr !== "" ? { stderr: progress.stderr } : {}),
		durationMs: progress?.durationMs ?? 0,
		usage: progress?.usage ?? emptyUsage(),
		events: progress?.events ?? [],
	};
}

function compactResults(results: Array<SubagentRunResult | undefined>): SubagentRunResult[] {
	return results.filter((result): result is SubagentRunResult => result !== undefined);
}

function cloneTasks(tasks: SubagentTask[]): SubagentTask[] {
	return tasks.map((task) => ({
		agent: task.agent,
		task: task.task,
		...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
	}));
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			const item = items[index];
			if (item !== undefined) results[index] = await fn(item, index);
		}
	});
	await Promise.all(workers);
	return results;
}

function createRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return;
	try {
		if (signal === undefined) await sleep(ms);
		else await sleep(ms, undefined, { signal });
	} catch (error) {
		if (signal?.aborted) throw new SubagentExecutionError("subagent aborted");
		throw error;
	}
}

function emptyProcessOutput(): ProcessRunOutput {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
	return { exitCode: 1, output: "", stderr: "", usage, events: [], durationMs: 0, timedOut: false, aborted: false, parseErrors: 0, wrote: false };
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}

function truncateError(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= 4000 ? trimmed : `${trimmed.slice(0, 4000)}\n[stderr truncated]`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
