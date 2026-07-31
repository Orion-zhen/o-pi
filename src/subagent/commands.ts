import { discoverAgents, hasWriteCapability, resolveSubagentTools } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { formatModelReference } from "./model.js";
import { runSubagentTasks } from "./progress.js";
import type {
	AgentDefinition,
	ExecutorContext,
	ParentModel,
	ParentSessionManager,
	SubagentConfig,
	SubagentInteractionPort,
	SubagentProgressCallback,
	SubagentTask,
	SubagentToolResult,
	ToolInfo,
} from "./types.js";

export interface AutocompleteItem {
	value: string;
	label: string;
}

export interface SubagentRuntimePort {
	getActiveTools(): string[];
	getAllTools(): ToolInfo[];
	getThinkingLevel(): string;
}

export interface SubagentCommandContext {
	cwd: string;
	model: ParentModel | undefined;
	sessionManager: ParentSessionManager;
	systemPrompt: string;
	signal?: AbortSignal;
	interaction?: SubagentInteractionPort;
}

/** 执行 /run application 流程；结果保存和展示由 adapter 决定。 */
export function runSubagentCommand(
	port: SubagentRuntimePort,
	context: SubagentCommandContext,
	tasks: SubagentTask[],
	onProgress?: SubagentProgressCallback,
): Promise<SubagentToolResult> {
	return runSubagentTasks(
		{ tasks },
		{
			...captureExecutorContext(port, context, "command"),
			...(context.signal === undefined ? {} : { signal: context.signal }),
			...(context.interaction === undefined ? {} : { interaction: context.interaction }),
		},
		onProgress,
	);
}

export async function queryAgentsSummary(
	port: Pick<SubagentRuntimePort, "getActiveTools" | "getAllTools">,
	input: { cwd: string; model: ParentModel | undefined },
): Promise<string> {
	const config = await loadSubagentConfig(input.cwd);
	const discovery = discoverAgents(input.cwd, config);
	const model = formatModelReference(input.model);
	return formatAgents(discovery.agents, config, registeredToolNames(port), {
		...(model === undefined ? {} : { model }),
		tools: port.getActiveTools(),
		cwd: input.cwd,
	});
}

export async function querySubagentConfigSummary(cwd: string): Promise<string> {
	const config = await loadSubagentConfig(cwd);
	return [
		`max_parallel_tasks: ${config.maxParallelTasks}`,
		`max_concurrency: ${config.maxConcurrency}`,
		`timeout_ms: ${config.timeoutMs}`,
		`retries: ${config.retries}`,
		`max_inline_output_tokens: ${config.maxInlineOutputTokens}`,
		`max_handoff_tokens: ${config.maxHandoffTokens}`,
		`allow_project_agents: ${config.allowProjectAgents}`,
		`confirm_write_agents: ${config.confirmWriteAgents}`,
		`default_tools: ${config.defaultTools.join(", ")}`,
	].join("\n");
}

export async function completeAgents(prefix: string, cwd = process.cwd()): Promise<AutocompleteItem[] | null> {
	const config = await loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, config);
	const items = discovery.agents
		.filter((agent) => agent.name.startsWith(prefix.trim()))
		.map((agent) => ({ value: agent.name, label: `${agent.name} - ${agent.description}` }));
	return items.length > 0 ? items : null;
}

export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch ?? "")) {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (quote !== undefined) throw new Error(`Unclosed quote ${quote}.`);
	if (current !== "") tokens.push(current);
	return tokens;
}

export function parsePipeline(input: string): { tasks: SubagentTask[] } | { error: string } {
	const parts = splitPipeline(input);
	if (parts.length === 0) return { error: "Syntax requires at least one <agent> <task> segment." };
	const tasks: SubagentTask[] = [];
	for (const part of parts) {
		let tokens: string[];
		try {
			tokens = tokenize(part);
		} catch (error) {
			return { error: errorMessage(error) };
		}
		const [agent, ...rest] = tokens;
		if (agent === undefined || rest.length === 0) return { error: `Invalid segment: ${part.trim()}` };
		tasks.push({ agent, task: rest.join(" ") });
	}
	return { tasks };
}

export function formatAgents(
	agents: AgentDefinition[],
	config: SubagentConfig,
	registeredTools: string[],
	parent?: { model?: string; tools: readonly string[]; cwd: string },
): string {
	if (agents.length === 0) return "No subagents found.";
	return agents
		.map((agent) => {
			const tools = agent.fork && parent !== undefined ? [...parent.tools] : resolveSubagentTools(agent, config, registeredTools);
			const model = agent.fork && parent !== undefined ? parent.model : agent.model ?? "(current)";
			return [
				`${agent.name} - ${agent.description}`,
				`  source: ${agent.source} (${agent.filePath})`,
				`  mode: ${agent.fork ? "fork" : "isolated"}`,
				`  model: ${model ?? "(unavailable)"}`,
				`  tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}`,
				`  cwd: ${agent.fork && parent !== undefined ? parent.cwd : "(task/workspace)"}`,
				`  write: ${hasWriteCapability(tools) ? "yes" : "no"}`,
			].join("\n");
		})
		.join("\n\n");
}

export function captureExecutorContext(
	port: SubagentRuntimePort,
	ctx: {
		cwd: string;
		model: ParentModel | undefined;
		sessionManager: ParentSessionManager;
		systemPrompt: string;
	},
	invocation: "tool" | "command",
	toolCallId?: string,
): Pick<
	ExecutorContext,
	"cwd" | "currentModel" | "activeTools" | "allTools" | "thinkingLevel" | "sessionManager" | "systemPrompt" | "invocation" | "toolCallId"
> {
	return {
		cwd: ctx.cwd,
		...(ctx.model === undefined ? {} : { currentModel: ctx.model }),
		activeTools: port.getActiveTools(),
		allTools: port.getAllTools(),
		thinkingLevel: port.getThinkingLevel(),
		sessionManager: ctx.sessionManager,
		systemPrompt: ctx.systemPrompt,
		invocation,
		...(toolCallId === undefined ? {} : { toolCallId }),
	};
}

function registeredToolNames(port: Pick<SubagentRuntimePort, "getAllTools">): string[] {
	return port.getAllTools().map((tool) => tool.name);
}

function splitPipeline(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "|") {
			if (current.trim() !== "") parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") parts.push(current);
	return parts;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
