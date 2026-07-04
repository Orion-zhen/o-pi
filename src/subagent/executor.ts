import { realpath } from "node:fs/promises";
import path from "node:path";
import { discoverAgents, formatAvailableAgents, resolveSubagentTools } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { formatFileHandoff, formatResultForContext, limitHandoff, persistResult } from "./output.js";
import { runPiProcess } from "./process.js";
import type {
	AgentDefinition,
	ExecutorContext,
	ExecutorOptions,
	OutputMode,
	ProcessRunOutput,
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
	const mode = resolveMode(params);
	const runId = createRunId();
	const detailsBase = (results: SubagentRunResult[]): SubagentDetails => ({ mode, runId, results, warnings: discovery.warnings });

	try {
		if (mode === "single") {
			const task = { agent: requireText(params.agent, "agent"), task: requireText(params.task, "task"), ...(params.cwd !== undefined ? { cwd: params.cwd } : {}) };
			const result = await executeOne(task, 0, mode, runId, params, context, config, discovery.agents);
			const persisted = await persistResult(result, { cwd: result.cwd, runId, index: 0, outputMode: effectiveOutputMode(result, params, config), maxInlineOutputChars: config.maxInlineOutputChars });
			const content = resultToContent(persisted, effectiveOutputMode(persisted, params, config), config);
			return { content: [{ type: "text", text: content }], details: detailsBase([persisted]) };
		}
		if (mode === "parallel") {
			const tasks = params.tasks ?? [];
			if (tasks.length > config.maxParallelTasks) {
				throw new SubagentExecutionError(`Too many parallel tasks (${tasks.length}). Max is ${config.maxParallelTasks}.`);
			}
			const results = await mapWithConcurrency(tasks, config.maxConcurrency, async (task, index) => {
				const result = await executeOne(task, index, mode, runId, params, context, config, discovery.agents);
				const persisted = await persistResult(result, { cwd: result.cwd, runId, index, outputMode: effectiveOutputMode(result, params, config), maxInlineOutputChars: config.maxInlineOutputChars });
				emitUpdate(context, detailsBase, replaceResult([], persisted, index));
				if (options.failFast === true && persisted.error !== undefined) throw new SubagentExecutionError(persisted.error);
				return persisted;
			});
			const success = results.filter((result) => result.error === undefined).length;
			const text = [`Parallel: ${success}/${results.length} succeeded`, "", ...results.map((result) => `### ${result.agent}\n\n${resultToContent(result, effectiveOutputMode(result, params, config), config)}`)].join("\n");
			return { content: [{ type: "text", text }], details: detailsBase(results) };
		}
		const chain = params.chain ?? [];
		const results: SubagentRunResult[] = [];
		let previous = "";
		for (let i = 0; i < chain.length; i++) {
			const step = chain[i];
			if (step === undefined) continue;
			const taskText = step.task.replace(/\{previous\}/g, previous);
			const result = await executeOne({ ...step, task: taskText }, i, mode, runId, params, context, config, discovery.agents);
			const persisted = await persistResult(result, { cwd: result.cwd, runId, index: i, outputMode: effectiveOutputMode(result, params, config), maxInlineOutputChars: config.maxInlineOutputChars });
			results.push(persisted);
			emitUpdate(context, detailsBase, results);
			if (persisted.error !== undefined) {
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${persisted.agent}): ${persisted.error}` }],
					details: detailsBase(results),
				};
			}
			previous =
				effectiveOutputMode(persisted, params, config) === "file"
					? formatFileHandoff(persisted)
					: limitHandoff(persisted.output ?? "", config.maxHandoffChars);
		}
		const last = results.at(-1);
		return { content: [{ type: "text", text: last === undefined ? "(no output)" : resultToContent(last, effectiveOutputMode(last, params, config), config) }], details: detailsBase(results) };
	} catch (error) {
		const available = formatAvailableAgents(discovery.agents);
		const text = `${errorMessage(error)}\nAvailable agents: ${available}`;
		return { content: [{ type: "text", text }], details: detailsBase([]) };
	}
}

export function resolveMode(params: SubagentToolParams): SubagentMode {
	const hasSingle = params.agent !== undefined || params.task !== undefined;
	const hasParallel = (params.tasks?.length ?? 0) > 0;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const count = Number(hasSingle) + Number(hasParallel) + Number(hasChain);
	if (count !== 1) throw new SubagentExecutionError("Provide exactly one mode: agent+task, tasks, or chain.");
	if (hasSingle) {
		if (params.agent === undefined || params.task === undefined) throw new SubagentExecutionError("Single mode requires agent and task.");
		return "single";
	}
	if (hasParallel) return "parallel";
	return "chain";
}

async function executeOne(
	task: SubagentTask,
	index: number,
	mode: SubagentMode,
	runId: string,
	params: SubagentToolParams,
	context: ExecutorContext,
	config: SubagentConfig,
	agents: AgentDefinition[],
): Promise<SubagentRunResult> {
	const agent = agents.find((candidate) => candidate.name === task.agent);
	if (agent === undefined) throw new SubagentExecutionError(`Unknown agent "${task.agent}".`);
	const cwd = await resolveCwd(task.cwd ?? params.cwd ?? context.cwd, context.cwd);
	const tools = resolveTools(agent, config, context.activeTools);
	const model = resolveModel(params.model, agent, config, context);
	await confirmIfNeeded(agent, task.task, cwd, tools, config, context);
	const maxAttempts = Math.max(1, (agent.retries ?? config.retries) + 1);
	let attempts = 0;
	let last: ProcessRunOutput | undefined;
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
			context.signal,
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
		...(agent.outputMode !== undefined ? { outputMode: agent.outputMode } : {}),
		...(output.stderr !== "" ? { stderr: output.stderr } : {}),
		durationMs: output.durationMs,
		usage: output.usage,
		events: output.events,
	};
}

function resolveTools(agent: AgentDefinition, config: SubagentConfig, activeTools: string[] | undefined): string[] {
	const tools = resolveSubagentTools(agent, config, activeTools);
	if (tools.length === 0) {
		throw new SubagentExecutionError(`Agent "${agent.name}" has no usable tools after intersecting configured tools with active tools.`);
	}
	return tools;
}

function resolveModel(requested: string | undefined, agent: AgentDefinition, config: SubagentConfig, context: ExecutorContext): string | undefined {
	if (requested !== undefined) {
		const modelIds = context.modelIds ?? [];
		if (modelIds.length > 0 && !modelIds.includes(requested)) throw new SubagentExecutionError(`Model is not available: ${requested}`);
		return requested;
	}
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

function effectiveOutputMode(result: SubagentRunResult, params: SubagentToolParams, config: SubagentConfig): OutputMode {
	return params.outputMode ?? result.outputMode ?? config.outputMode;
}

function resultToContent(result: SubagentRunResult, outputMode: OutputMode, config: SubagentConfig): string {
	if (result.error !== undefined) return `${result.error}\n${truncateError(result.stderr ?? "")}`.trim();
	return formatResultForContext(result, outputMode, config.maxInlineOutputChars);
}

function emitUpdate(context: ExecutorContext, makeDetails: (results: SubagentRunResult[]) => SubagentDetails, results: SubagentRunResult[]): void {
	context.onUpdate?.({ content: [{ type: "text", text: `Subagents ${results.length} updated` }], details: makeDetails(results) });
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

function replaceResult(results: SubagentRunResult[], result: SubagentRunResult, index: number): SubagentRunResult[] {
	const next = [...results];
	next[index] = result;
	return next;
}

function createRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

function requireText(value: string | undefined, field: string): string {
	if (value !== undefined && value.trim() !== "") return value;
	throw new SubagentExecutionError(`${field} is required.`);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal !== undefined) {
			const abort = () => {
				clearTimeout(timer);
				reject(new SubagentExecutionError("subagent aborted"));
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function emptyProcessOutput(): ProcessRunOutput {
	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
	return { exitCode: 1, output: "", stderr: "", usage, events: [], durationMs: 0, timedOut: false, aborted: false, parseErrors: 0, wrote: false };
}

function truncateError(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= 4000 ? trimmed : `${trimmed.slice(0, 4000)}\n[stderr truncated]`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
