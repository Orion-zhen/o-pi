import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, hasWriteCapability, resolveSubagentTools } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { executeSubagent, resolveMode } from "./executor.js";
import { formatModelReference } from "./model.js";
import { renderSubagentCommandWidget, SUBAGENT_COMMAND_ENTRY } from "./renderer.js";
import type { AgentDefinition, SubagentConfig, SubagentTask, SubagentToolResult } from "./types.js";

interface AutocompleteItem {
	value: string;
	label: string;
}

interface SubagentCommandApi {
	appendEntry<T>(customType: string, data?: T): void;
	getAllTools(): Array<{ name: string }>;
	registerCommand: ExtensionAPI["registerCommand"];
}

interface SubagentCommandContext {
	cwd: ExtensionCommandContext["cwd"];
	hasUI: ExtensionCommandContext["hasUI"];
	model: ExtensionCommandContext["model"];
	signal: ExtensionCommandContext["signal"];
	ui: Pick<ExtensionCommandContext["ui"], "confirm" | "getToolsExpanded" | "notify" | "setWidget">;
}

let commandWidgetSequence = 0;

/** 注册不经过主模型的确定性命令入口。 */
export function registerSubagentCommands(pi: SubagentCommandApi): void {
	pi.registerCommand("agents", {
		description: "List available subagents",
			handler: async (_args, ctx) => {
				const config = await loadSubagentConfig(ctx.cwd);
				const discovery = discoverAgents(ctx.cwd, config);
				ctx.ui.notify(formatAgents(discovery.agents, config, registeredToolNames(pi)), "info");
			},
		});

	pi.registerCommand("run", {
		description: 'Run subagents: /run scout "task" | reviewer "task"',
		getArgumentCompletions: (prefix) => completeAgents(prefix),
		handler: async (args, ctx) => {
			const parsed = parsePipeline(args);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			await runSubagentCommand(pi, ctx, parsed.tasks);
		},
	});

	pi.registerCommand("subagent-config", {
		description: "Show subagent config summary",
		handler: async (_args, ctx) => {
			const config = await loadSubagentConfig(ctx.cwd);
			ctx.ui.notify(
				[
					`max_parallel_tasks: ${config.maxParallelTasks}`,
					`max_concurrency: ${config.maxConcurrency}`,
					`timeout_ms: ${config.timeoutMs}`,
					`retries: ${config.retries}`,
					`max_inline_output_tokens: ${config.maxInlineOutputTokens}`,
					`max_handoff_tokens: ${config.maxHandoffTokens}`,
					`allow_project_agents: ${config.allowProjectAgents}`,
					`confirm_write_agents: ${config.confirmWriteAgents}`,
					`default_tools: ${config.defaultTools.join(", ")}`,
				].join("\n"),
				"info",
			);
		},
	});
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

export async function runSubagentCommand(
	pi: Pick<SubagentCommandApi, "appendEntry" | "getAllTools">,
	ctx: SubagentCommandContext,
	tasks: SubagentTask[],
): Promise<void> {
	const widgetKey = `subagent-command-${++commandWidgetSequence}`;
	const show = (result: SubagentToolResult, isPartial: boolean): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(widgetKey, (_tui, theme) => renderSubagentCommandWidget(result, {
			expanded: ctx.ui.getToolsExpanded(),
			isPartial,
		}, theme));
	};
	show(pendingResult(tasks), true);
	try {
		const result = await executeSubagent(
			{ tasks },
			{
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				currentModel: formatModelReference(ctx.model),
				registeredTools: registeredToolNames(pi),
				signal: ctx.signal,
				confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
				onUpdate: (partial) => show(partial, true),
			},
		);
		if (ctx.hasUI) pi.appendEntry<SubagentToolResult>(SUBAGENT_COMMAND_ENTRY, result);
		else {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
			const failed = result.details.results.some((item) => item.error !== undefined) || result.details.results.length === 0;
			ctx.ui.notify(text, failed ? "error" : "info");
		}
	} finally {
		if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
	}
}

function pendingResult(tasks: SubagentTask[]): SubagentToolResult {
	return {
		content: [{ type: "text", text: "Subagents starting" }],
		details: {
			mode: resolveMode(tasks),
			runId: "pending",
			tasks: tasks.map((task) => ({ ...task })),
			results: [],
			warnings: [],
		},
	};
}

async function completeAgents(prefix: string): Promise<AutocompleteItem[] | null> {
	const config = await loadSubagentConfig(process.cwd());
	const discovery = discoverAgents(process.cwd(), config);
	const items = discovery.agents
		.filter((agent) => agent.name.startsWith(prefix.trim()))
		.map((agent) => ({ value: agent.name, label: `${agent.name} - ${agent.description}` }));
	return items.length > 0 ? items : null;
}

export function formatAgents(agents: AgentDefinition[], config: SubagentConfig, registeredTools: string[]): string {
	if (agents.length === 0) return "No subagents found.";
	return agents
		.map((agent) => {
			const tools = resolveSubagentTools(agent, config, registeredTools);
			return [
				`${agent.name} - ${agent.description}`,
				`  source: ${agent.source} (${agent.filePath})`,
				`  model: ${agent.model ?? "(current)"}`,
				`  tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}`,
				`  write: ${hasWriteCapability(tools) ? "yes" : "no"}`,
			].join("\n");
		})
		.join("\n\n");
}

/** Pi 的 getAllTools 返回已注册工具元数据；子 Agent 只需要名称用于 --tools。 */
function registeredToolNames(pi: Pick<SubagentCommandApi, "getAllTools">): string[] {
	return pi.getAllTools().map((tool) => tool.name);
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
