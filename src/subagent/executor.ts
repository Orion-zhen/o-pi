import { realpath } from "node:fs/promises";
import path from "node:path";
import type { TokenCounterScope } from "../token-counter.js";
import { discoverAgents, hasWriteCapability, resolveSubagentTools } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { formatModelReference } from "./model.js";
import { exceedsTokenLimit, formatFileHandoff, formatResultForContext, persistResult } from "./output.js";
import { runPiProcess } from "./process.js";
import { cleanupForkExecutionContext, createForkExecutionContext, formatForkAssignment } from "./session-context.js";
import type {
	AgentDefinition,
	ContextMode,
	ExecutorContext,
	ForkExecutionContext,
	NonEmptyArray,
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
	UnpersistedSubagentRunResult,
	UsageStats,
} from "./types.js";

export class SubagentExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentExecutionError";
	}
}

interface PreparedTask {
	task: SubagentTask;
	agent: AgentDefinition;
	contextMode: ContextMode;
	cwd: string;
	tools: string[];
	model?: string;
	fork?: ForkExecutionContext;
}

/** 工具与 slash command 共用的执行入口。 */
export async function executeSubagent(params: SubagentToolParams, context: ExecutorContext): Promise<SubagentToolResult> {
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
	const selections = params.tasks.map((task) => ({ task, agent: requireAgent(task.agent, discovery.agents) })) as NonEmptyArray<{
		task: SubagentTask;
		agent: AgentDefinition;
	}>;
	let forkContext: ForkExecutionContext | undefined;

	try {
		if (selections.some(({ agent }) => agent.fork)) forkContext = await requireForkContext(context);
		const preparedTasks = await prepareTasks(selections, context, config, forkContext);
		if (mode === "parallel") {
			const liveResults: Array<SubagentRunResult | undefined> = new Array(preparedTasks.length);
			emitUpdate(context, details, compactResults(liveResults));
			const results = await mapWithConcurrency(preparedTasks, config.maxConcurrency, async (prepared, index) => {
				const result = await executeOne(prepared, prepared.task.task, mode, runId, config, context, (partial) => {
					liveResults[index] = partial;
					emitUpdate(context, details, compactResults(liveResults));
				});
				const persisted = await persistResult(result, { cwd: result.cwd, runId, index });
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
		return executeChain(preparedTasks, runId, config, context, details, tokenScope);
	} finally {
		if (forkContext !== undefined) await cleanupForkExecutionContext(forkContext);
	}
}

export function resolveMode(tasks: readonly SubagentTask[]): SubagentMode {
	return tasks.some((task) => task.task.includes("{previous}")) ? "chain" : "parallel";
}

async function prepareTasks(
	selections: NonEmptyArray<{ task: SubagentTask; agent: AgentDefinition }>,
	context: ExecutorContext,
	config: SubagentConfig,
	forkContext: ForkExecutionContext | undefined,
): Promise<NonEmptyArray<PreparedTask>> {
	const prepared: PreparedTask[] = [];
	const registeredTools = context.allTools.map((tool) => tool.name);
	for (const { task, agent } of selections) {
		const fork = agent.fork ? requirePreparedFork(forkContext) : undefined;
		const cwd = fork === undefined ? await resolveCwd(task.cwd ?? context.cwd, context.cwd) : fork.cwd;
		const tools = fork === undefined ? resolveTools(agent, config, registeredTools) : [...fork.activeTools];
		const model = fork === undefined ? resolveModel(agent, config, context) : formatModelReference(fork.model);
		await confirmIfNeeded(agent, task.task, cwd, tools, config, context);
		prepared.push({
			task,
			agent,
			contextMode: fork === undefined ? "isolated" : "fork",
			cwd,
			tools,
			...(model === undefined ? {} : { model }),
			...(fork === undefined ? {} : { fork }),
		});
	}
	return prepared as NonEmptyArray<PreparedTask>;
}

async function executeOne(
	prepared: PreparedTask,
	taskText: string,
	mode: SubagentMode,
	runId: string,
	config: SubagentConfig,
	context: ExecutorContext,
	onProgress: (result: SubagentRunningResult) => void,
): Promise<UnpersistedSubagentRunResult> {
	const base = {
		runId,
		mode,
		contextMode: prepared.contextMode,
		agent: prepared.agent,
		task: taskText,
		cwd: prepared.cwd,
		...(prepared.model === undefined ? {} : { model: prepared.model }),
		tools: prepared.tools,
	};
	onProgress(runningResult(base));
	const output = await runPiProcess(
		prepared.fork === undefined
			? {
				contextMode: "isolated",
				runId,
				mode,
				agent: prepared.agent,
				task: taskText,
				cwd: prepared.cwd,
				...(prepared.model === undefined ? {} : { model: prepared.model }),
				tools: prepared.tools,
				timeoutMs: prepared.agent.timeoutMs ?? config.timeoutMs,
			}
			: {
				contextMode: "fork",
				runId,
				mode,
				agent: prepared.agent,
				task: taskText,
				forkContext: prepared.fork,
				assignment: formatForkAssignment(prepared.agent.body, taskText),
				timeoutMs: prepared.agent.timeoutMs ?? config.timeoutMs,
			},
		{
			...(context.signal === undefined ? {} : { signal: context.signal }),
			onUpdate: (progress) => onProgress(runningResult(base, progress)),
		},
	);
	const failure = validateProcessOutput(output);
	return {
		status: "completed",
		runId,
		mode,
		contextMode: prepared.contextMode,
		agent: prepared.agent.name,
		source: prepared.agent.source,
		task: taskText,
		cwd: prepared.cwd,
		...(prepared.model === undefined ? {} : { model: prepared.model }),
		tools: prepared.tools,
		exitCode: output.exitCode,
		...(output.stopReason !== undefined ? { stopReason: output.stopReason } : {}),
		...(failure !== undefined ? { error: failure } : {}),
		output: output.output,
		...(output.stderr === "" ? {} : { stderr: output.stderr }),
		durationMs: output.durationMs,
		usage: output.usage,
		events: output.events,
	};
}

async function executeChain(
	preparedTasks: NonEmptyArray<PreparedTask>,
	runId: string,
	config: SubagentConfig,
	context: ExecutorContext,
	details: (results: SubagentRunResult[]) => SubagentDetails,
	tokenScope: TokenCounterScope,
): Promise<SubagentToolResult> {
	const results: SubagentCompletedResult[] = [];
	let previous = "";
	for (const [index, prepared] of preparedTasks.entries()) {
		const taskText = prepared.task.task.replace(/\{previous\}/g, previous);
		const result = await executeOne(prepared, taskText, "chain", runId, config, context, (partial) => {
			emitUpdate(context, details, [...results, partial]);
		});
		const persisted = await persistResult(result, { cwd: result.cwd, runId, index });
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

function requirePreparedFork(context: ForkExecutionContext | undefined): ForkExecutionContext {
	if (context === undefined) throw new Error("fork context was not prepared");
	return context;
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

function validateProcessOutput(output: ProcessRunOutput): string | undefined {
	if (output.timedOut) return "subagent timed out";
	if (output.aborted) return "subagent aborted";
	if (output.parseErrors > 0) return `Pi JSON protocol error: ${output.parseErrors} malformed event${output.parseErrors === 1 ? "" : "s"}`;
	if (output.error !== undefined) return output.error;
	if (output.exitCode !== 0) return `subagent exited with code ${output.exitCode}`;
	if (output.stopReason === "error" || output.stopReason === "aborted") return `subagent stopReason: ${output.stopReason}`;
	if (output.output.trim() === "") return "empty output";
	return undefined;
}

function resultToContent(result: SubagentCompletedResult, config: SubagentConfig, tokenScope: TokenCounterScope): string {
	if (result.error !== undefined) return `${result.error}\n${truncateError(result.stderr ?? "")}`.trim();
	return formatResultForContext(result, config.maxInlineOutputTokens, tokenScope);
}

function emitUpdate(context: ExecutorContext, makeDetails: (results: SubagentRunResult[]) => SubagentDetails, results: SubagentRunResult[]): void {
	context.onUpdate?.({ content: [{ type: "text", text: `Subagents ${results.length} updated` }], details: makeDetails(results) });
}

function runningResult(input: {
	runId: string;
	mode: SubagentMode;
	contextMode: ContextMode;
	agent: AgentDefinition;
	task: string;
	cwd: string;
	model?: string;
	tools: string[];
}, progress: ProcessRunProgress = emptyProgress()): SubagentRunningResult {
	return {
		status: "running",
		runId: input.runId,
		mode: input.mode,
		contextMode: input.contextMode,
		agent: input.agent.name,
		source: input.agent.source,
		task: input.task,
		cwd: input.cwd,
		...(input.model === undefined ? {} : { model: input.model }),
		tools: input.tools,
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
	return tasks.map((task) => ({
		agent: task.agent,
		task: task.task,
		...(task.cwd === undefined ? {} : { cwd: task.cwd }),
	})) as NonEmptyArray<SubagentTask>;
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
