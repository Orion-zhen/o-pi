import { realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TokenCounterScope } from "../token-counter.ts";
import { discoverAgents, hasWriteCapability, resolveSubagentTools } from "./agents.ts";
import { loadSubagentConfig } from "./config.ts";
import { formatModelReference } from "./model.ts";
import { exceedsTokenLimit, formatFileHandoff, formatResultForContext, persistResult } from "./output.ts";
import { runPiProcess } from "./process.ts";
import { createForkExecutionContext, formatForkAssignment } from "./session-context.ts";
import type {
	AgentDefinition,
	ExecutorContext,
	ForkExecutionContext,
	NonEmptyArray,
	ProcessRunInput,
	ProcessRunOutput,
	ProcessRunProgress,
	SubagentCompletedResult,
	SubagentConfig,
	SubagentDetails,
	SubagentMode,
	SubagentRunResult,
	SubagentRunningResult,
	SubagentTask,
	SubagentToolParams,
	SubagentToolResult,
	UsageStats,
} from "./types.ts";

export class SubagentExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentExecutionError";
	}
}

interface TaskSelection {
	task: SubagentTask;
	agent: AgentDefinition;
}

type SelectedTask = TaskSelection & (
	| { contextMode: "isolated" }
	| { contextMode: "fork"; fork: ForkExecutionContext }
);

type RunIdentity = Pick<SubagentRunningResult, "runId" | "mode" | "contextMode" | "agent" | "source" | "task" | "cwd" | "model" | "tools">;

interface PreparedTask {
	identity: RunIdentity;
	maxAttempts: number;
	inputForTask(task: string): ProcessRunInput;
}

/** 工具与 slash command 共用的执行入口。 */
export async function executeSubagent(params: SubagentToolParams, context: ExecutorContext): Promise<SubagentToolResult> {
	context.onProgress?.({ phase: "starting", result: pendingSubagentResult(params.tasks) });
	const executed = await executeTasks(params, context);
	const result = { ...executed, isError: executed.details.results.some((item) => item.error !== undefined) };
	context.onProgress?.({ phase: "completed", result });
	return result;
}

export function pendingSubagentResult(tasks: NonEmptyArray<SubagentTask>): SubagentToolResult {
	return {
		content: [{ type: "text", text: "Subagents starting" }],
		details: { mode: resolveMode(tasks), runId: "pending", tasks: cloneTasks(tasks), results: [], warnings: [] },
	};
}

async function executeTasks(params: SubagentToolParams, context: ExecutorContext): Promise<SubagentToolResult> {
	const config = await loadSubagentConfig(context.cwd);
	const discovery = discoverAgents(context.cwd, config);
	const mode = resolveMode(params.tasks);
	if (mode === "parallel" && params.tasks.length > config.maxParallelTasks) {
		throw new SubagentExecutionError(`Too many parallel tasks (${params.tasks.length}). Max is ${config.maxParallelTasks}.`);
	}
	const tokenScope: TokenCounterScope = context.currentModel === undefined ? {} : {
		provider: context.currentModel.provider,
		modelId: context.currentModel.id,
		baseUrl: context.currentModel.baseUrl,
	};
	const runId = createRunId();
	const tasks = cloneTasks(params.tasks);
	const details = (results: SubagentRunResult[]): SubagentDetails => ({ mode, runId, tasks, results, warnings: discovery.warnings });
	const selections = mapNonEmpty(params.tasks, (task) => ({ task, agent: requireAgent(task.agent, discovery.agents) }));
	let forkContext: ForkExecutionContext | undefined;

	try {
		let selected: NonEmptyArray<SelectedTask>;
		if (selections.some(({ agent }) => agent.fork)) {
			const fork = await requireForkContext(context);
			forkContext = fork;
			selected = mapNonEmpty(selections, (selection) => selection.agent.fork
				? { ...selection, contextMode: "fork", fork }
				: { ...selection, contextMode: "isolated" });
		} else {
			selected = mapNonEmpty(selections, (selection) => ({ ...selection, contextMode: "isolated" }));
		}
		const preparedTasks = await prepareTasks(selected, context, config, runId, mode);
		if (mode === "parallel") {
			const liveResults: Array<SubagentRunResult | undefined> = new Array(preparedTasks.length);
			emitUpdate(context, details, compactResults(liveResults));
			const results = await mapWithConcurrency(preparedTasks, config.maxConcurrency, async (prepared, index) => {
				const persisted = await executeOne(prepared, prepared.identity.task, index, config, context, (partial) => {
					liveResults[index] = partial;
					emitUpdate(context, details, compactResults(liveResults));
				});
				liveResults[index] = persisted;
				emitUpdate(context, details, compactResults(liveResults));
				return persisted;
			});
			const success = results.filter((result) => result.error === undefined).length;
			const [first, ...remaining] = results;
			const text = remaining.length === 0
				? resultToContent(first, config, tokenScope)
				: [`Subagents: ${success}/${results.length} succeeded`, "", ...results.map((result) => `### ${result.agent}\n\n${resultToContent(result, config, tokenScope)}`)].join("\n");
			return { content: [{ type: "text", text }], details: details(results) };
		}
		return await executeChain(preparedTasks, config, context, details, tokenScope);
	} finally {
		if (forkContext !== undefined) await forkContext.dispose();
	}
}

export function resolveMode(tasks: readonly SubagentTask[]): SubagentMode {
	return tasks.some((task) => task.task.includes("{previous}")) ? "chain" : "parallel";
}

async function prepareTasks(
	selections: NonEmptyArray<SelectedTask>,
	context: ExecutorContext,
	config: SubagentConfig,
	runId: string,
	mode: SubagentMode,
): Promise<NonEmptyArray<PreparedTask>> {
	const registeredTools = context.allTools.map((tool) => tool.name);
	const prepare = async (selection: SelectedTask): Promise<PreparedTask> => {
		const { task, agent, contextMode } = selection;
		const input = { runId, mode, agent, timeoutMs: agent.timeoutMs ?? config.timeoutMs };
		let execution: Pick<RunIdentity, "contextMode" | "cwd" | "tools" | "model">;
		let inputForTask: PreparedTask["inputForTask"];
		if (selection.contextMode === "fork") {
			const { fork } = selection;
			execution = { contextMode, cwd: fork.cwd, tools: [...fork.activeTools], model: formatModelReference(fork.model) };
			inputForTask = (text) => ({
				...input, contextMode: "fork", forkContext: fork, task: text,
				assignment: formatForkAssignment(agent.body, text),
			});
		} else {
			const cwd = await resolveCwd(task.cwd ?? context.cwd, context.cwd);
			const tools = resolveTools(agent, config, registeredTools);
			const model = resolveModel(agent, config, context);
			const isolated = { contextMode: "isolated" as const, cwd, tools, ...(model === undefined ? {} : { model }) };
			execution = isolated;
			inputForTask = (text) => ({ ...input, ...isolated, task: text });
		}
		await confirmIfNeeded(agent, task.task, execution.cwd, execution.tools, config, context);
		return {
			identity: { runId, mode, agent: agent.name, source: agent.source, task: task.task, ...execution },
			maxAttempts: (agent.retries ?? config.retries) + 1,
			inputForTask,
		};
	};
	const [first, ...remaining] = selections;
	const prepared: NonEmptyArray<PreparedTask> = [await prepare(first)];
	for (const selection of remaining) prepared.push(await prepare(selection));
	return prepared;
}

async function executeOne(
	prepared: PreparedTask,
	taskText: string,
	index: number,
	config: SubagentConfig,
	context: ExecutorContext,
	onProgress: (result: SubagentRunningResult) => void,
): Promise<SubagentCompletedResult> {
	const base: RunIdentity = { ...prepared.identity, task: taskText };
	const processInput = prepared.inputForTask(taskText);
	let attempts = 0;
	let output: ProcessRunOutput;
	onProgress(runningResult(base, 0));
	while (true) {
		attempts += 1;
		if (attempts > 1) {
			await retryDelay(config.retryDelayMs, context.signal);
			onProgress(runningResult(base, attempts));
		}
		output = await runPiProcess(processInput, {
			...(context.signal === undefined ? {} : { signal: context.signal }),
			onUpdate: (progress) => onProgress(runningResult(base, attempts, progress)),
		});
		if (!shouldRetry(output, attempts, prepared.maxAttempts, base.tools, config)) break;
	}
	return persistResult({
		...base,
		status: "completed", attempts, exitCode: output.exitCode,
		...(output.stopReason === undefined ? {} : { stopReason: output.stopReason }),
		...(output.outcome.kind === "failed" ? { error: output.outcome.message } : {}),
		output: output.output,
		...(output.stderr === "" ? {} : { stderr: output.stderr }),
		durationMs: output.durationMs, usage: output.usage, events: output.events,
	}, { cwd: base.cwd, runId: base.runId, index });
}

async function executeChain(
	preparedTasks: NonEmptyArray<PreparedTask>,
	config: SubagentConfig,
	context: ExecutorContext,
	details: (results: SubagentRunResult[]) => SubagentDetails,
	tokenScope: TokenCounterScope,
): Promise<SubagentToolResult> {
	const results: SubagentCompletedResult[] = [];
	let previous = "";
	for (const [index, prepared] of preparedTasks.entries()) {
		const taskText = prepared.identity.task.replace(/\{previous\}/g, previous);
		const persisted = await executeOne(prepared, taskText, index, config, context, (partial) => {
			emitUpdate(context, details, [...results, partial]);
		});
		results.push(persisted);
		emitUpdate(context, details, results);
		if (persisted.error !== undefined) {
			return {
				content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${persisted.agent}): ${persisted.error}` }],
				details: details(results),
			};
		}
		previous = exceedsTokenLimit(persisted.output, Math.min(config.maxInlineOutputTokens, config.maxHandoffTokens), tokenScope)
			? formatFileHandoff(persisted)
			: persisted.output;
	}
	const last = results[results.length - 1] as SubagentCompletedResult;
	return { content: [{ type: "text", text: resultToContent(last, config, tokenScope) }], details: details(results) };
}

function resolveTools(agent: AgentDefinition, config: SubagentConfig, registeredTools: string[]): string[] {
	const tools = resolveSubagentTools(agent, config, registeredTools);
	if (tools.length === 0) {
		throw new SubagentExecutionError(`Agent "${agent.name}" has no usable tools after intersecting configured tools with registered tools.`);
	}
	return tools;
}

function resolveModel(agent: AgentDefinition, config: SubagentConfig, context: ExecutorContext): string | undefined {
	return config.agentOverrides[agent.name]?.model ?? agent.model ?? config.defaultModel ?? formatModelReference(context.currentModel);
}

async function requireForkContext(context: ExecutorContext): Promise<ForkExecutionContext> {
	try {
		return await createForkExecutionContext(context);
	} catch (error) {
		throw new SubagentExecutionError(`fork setup error: ${errorMessage(error)}`);
	}
}

function requireAgent(name: string, agents: AgentDefinition[]): AgentDefinition {
	const agent = agents.find((candidate) => candidate.name === name);
	if (agent !== undefined) return agent;
	const available = agents.length === 0 ? "none" : agents.map((candidate) => `${candidate.name} (${candidate.source})`).join(", ");
	throw new SubagentExecutionError(`Unknown agent "${name}". Available agents: ${available}.`);
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
	if (!config.confirmWriteAgents || !hasWriteCapability(tools)) return;
	if (context.interaction === undefined) throw new SubagentExecutionError(`Agent "${agent.name}" needs write-capable tools but confirmation UI is unavailable.`);
	const approved = await context.interaction.confirmWrite(
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
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new SubagentExecutionError(`cwd escapes workspace: ${input}`);
	}
	return target;
}

function shouldRetry(
	output: ProcessRunOutput,
	attempt: number,
	maxAttempts: number,
	tools: string[],
	config: SubagentConfig,
): boolean {
	if (output.outcome.kind === "success" || attempt >= maxAttempts || output.wrote || hasWriteCapability(tools)) return false;
	return output.outcome.reason === "timeout" && config.retryOnTimeout
		|| output.outcome.reason === "empty" && config.retryOnEmptyOutput;
}

async function retryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new SubagentExecutionError("subagent aborted");
	if (ms === 0) return;
	try {
		if (signal === undefined) await sleep(ms);
		else await sleep(ms, undefined, { signal });
	} catch (error) {
		if (signal?.aborted) throw new SubagentExecutionError("subagent aborted");
		throw error;
	}
}

function resultToContent(result: SubagentCompletedResult, config: SubagentConfig, tokenScope: TokenCounterScope): string {
	if (result.error !== undefined) return `${result.error}\n${truncateError(result.stderr ?? "")}`.trim();
	return formatResultForContext(result, config.maxInlineOutputTokens, tokenScope);
}

function emitUpdate(context: ExecutorContext, makeDetails: (results: SubagentRunResult[]) => SubagentDetails, results: SubagentRunResult[]): void {
	context.onProgress?.({ phase: "running", result: {
		content: [{ type: "text", text: `Subagents ${results.length} updated` }], details: makeDetails(results),
	} });
}

function runningResult(input: RunIdentity, attempts: number, progress: ProcessRunProgress = emptyProgress()): SubagentRunningResult {
	return {
		...input,
		status: "running",
		attempts,
		...(progress.stopReason === undefined ? {} : { stopReason: progress.stopReason }),
		...(progress.error === undefined ? {} : { error: progress.error }),
		output: progress.output,
		...(progress.stderr === "" ? {} : { stderr: progress.stderr }),
		durationMs: progress.durationMs,
		usage: progress.usage,
		events: progress.events,
	};
}

function compactResults(results: Array<SubagentRunResult | undefined>): SubagentRunResult[] {
	return results.filter((result): result is SubagentRunResult => result !== undefined);
}

function cloneTasks(tasks: NonEmptyArray<SubagentTask>): NonEmptyArray<SubagentTask> {
	return mapNonEmpty(tasks, (task) => ({
		agent: task.agent,
		task: task.task,
		...(task.cwd === undefined ? {} : { cwd: task.cwd }),
	}));
}

function mapNonEmpty<T, R>(items: NonEmptyArray<T>, map: (item: T) => R): NonEmptyArray<R> {
	return [map(items[0]), ...items.slice(1).map(map)];
}

async function mapWithConcurrency<T, R>(
	items: NonEmptyArray<T>,
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<NonEmptyArray<R>> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	let failure: unknown;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (!failed) {
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index] as T, index);
			} catch (error) {
				failed = true;
				failure = error;
			}
		}
	});
	await Promise.all(workers);
	if (failed) throw failure;
	return results as NonEmptyArray<R>;
}

function createRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

function emptyProgress(): ProcessRunProgress {
	return {
		output: "",
		stderr: "",
		usage: emptyUsage(),
		events: [],
		durationMs: 0,
		parseErrors: 0,
		wrote: false,
	};
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
