import os from "node:os";
import path from "node:path";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatToolCard } from "../tui/tool-card.js";
import { cleanText, compactWhitespace, formatDuration, joinParts, truncateEnd } from "../tui/text.js";
import type { RenderEvent, SubagentDetails, SubagentRunResult, SubagentTask, SubagentToolResult, UsageStats } from "./types.js";

export const SUBAGENT_COMMAND_ENTRY = "o-pi:subagent-command";

export function renderSubagentCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context?: { isPartial?: boolean }): Text {
	if (context?.isPartial !== undefined) return new Text("", 0, 0);
	const record = isRecord(args) ? args : {};
	return new Text(formatSubagentCall(record, theme), 0, 0);
}

export function renderSubagentResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Container | Text {
	const details = isDetails(result.details) ? result.details : undefined;
	if (details === undefined) return new Text(result.content[0]?.text ?? "(no output)", 0, 0);
	const container = new Container();
	if (details.results.length === 0 && details.tasks.length === 0) {
		container.addChild(new Text(result.content[0]?.text ?? "(no output)", 0, 0));
		return container;
	}
	container.addChild(new Text(formatSubagentSummary(details, options.isPartial, theme), 0, 0));
	if (!options.expanded) return container;
	if (details.results.length === 0) {
		if (!options.isPartial) container.addChild(new Text(theme.fg("error", result.content[0]?.text ?? "subagent failed"), 0, 0));
		return container;
	}
	for (const item of details.results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(formatRunHeader(item, theme), 0, 0));
		container.addChild(new Text(formatField("Task", item.task, theme), 0, 0));
		container.addChild(new Text(formatField("Cwd", displayPath(item.cwd), theme), 0, 0));
		if (item.model !== undefined) container.addChild(new Text(formatField("Model", item.model, theme), 0, 0));
		container.addChild(new Text(formatField("Tools", item.tools.join(", "), theme), 0, 0));
		if (item.outputFile !== undefined) container.addChild(new Text(formatField("Saved", displayOutputFile(item), theme, "accent"), 0, 0));

		const events = visibleEvents(item);
		if (events.length > 0 || item.exitCode === -1) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSection("Activity", theme), 0, 0));
			for (const line of formatEvents(events, item.exitCode === -1, theme)) container.addChild(new Text(line, 0, 0));
		}
		if (item.error !== undefined) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSection("Error", theme), 0, 0));
			container.addChild(new Text(indentBlock(item.error, theme, "error", 1600), 0, 0));
		}
		if (item.stderr !== undefined) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSection("Details", theme), 0, 0));
			container.addChild(new Text(indentBlock(item.stderr, theme, "error", 1600), 0, 0));
		}
		if (item.output !== undefined && item.output.trim() !== "") {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatSection("Result", theme), 0, 0));
			container.addChild(new Text(indentBlock(item.output, theme, "text", 3000), 0, 0));
		}
	}
	return container;
}

/** 为 /run 补上 Pi ToolExecutionComponent 默认提供的 padding 和状态背景。 */
export function renderSubagentCommandWidget(result: SubagentToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Box {
	const box = new Box(1, 1, commandBackground(result, options.isPartial, theme));
	box.addChild(renderSubagentResult(result, options, theme));
	return box;
}

/** 把手动 /run 的最终结果渲染为与 subagent 工具一致的持久卡片。 */
export function renderSubagentCommandEntry(data: unknown, expanded: boolean, theme: Theme): Box | undefined {
	if (!isToolResult(data)) return undefined;
	return renderSubagentCommandWidget(data, { expanded, isPartial: false }, theme);
}

function formatSubagentCall(record: Record<string, unknown>, theme: Pick<Theme, "fg" | "bold">): string {
	const tasks = Array.isArray(record["tasks"]) ? record["tasks"] : [];
	const agents = tasks.map((task) => isRecord(task) && typeof task["agent"] === "string" ? task["agent"] : undefined).filter((agent): agent is string => agent !== undefined);
	return formatToolCard({
		tool: "subagent",
		status: "running",
		target: agents.length > 0 ? formatAgentNames(agents) : `${tasks.length} tasks`,
		summary: formatTaskSummary(tasks.map(taskPreviewFromRecord)),
	}, theme);
}

function formatSubagentSummary(details: SubagentDetails, isPartial: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const done = details.results.filter((item) => item.exitCode !== -1).length;
	const failed = details.results.find((item) => item.error !== undefined);
	const usage = sumUsage(details.results);
	const didNotRun = !isPartial && details.results.length === 0;
	const status = isPartial ? "running" : failed === undefined && !didNotRun ? "success" : "error";
	const tasks = details.results.length > 0
		? details.results.map((item) => ({ agent: item.agent, task: item.task }))
		: details.tasks;
	const agents = tasks.map((task) => task.agent);
	const target = joinParts([
		formatAgentNames(agents),
		details.results.length > 1 || details.tasks.length > 1 ? `${done}/${Math.max(details.results.length, details.tasks.length)} done` : undefined,
		failed !== undefined || didNotRun ? "failed" : undefined,
		usage.turns > 0 ? `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}` : undefined,
		totalTokens(usage) > 0 ? `${formatTokens(totalTokens(usage))} tok` : undefined,
		usage.cost !== undefined && usage.cost > 0 ? `$${usage.cost.toFixed(3)}` : undefined,
	], " · ");
	return formatToolCard({ tool: "subagent", status, target, summary: formatTaskSummary(tasks) }, theme);
}

function formatRunHeader(result: SubagentRunResult, theme: Theme): string {
	const failed = result.error !== undefined;
	const running = result.exitCode === -1;
	const icon = running ? theme.fg("warning", "●") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const attemptText = result.attempts > 1 ? `${result.attempts} attempts` : undefined;
	const status = running ? "running" : failed ? "failed" : undefined;
	const suffix = joinParts([status, attemptText, formatDuration(result.durationMs)]);
	return `  ${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${suffix === "" ? "" : `  ${theme.fg("muted", suffix)}`}`;
}

function formatEvents(events: RenderEvent[], running: boolean, theme: Pick<Theme, "fg">): string[] {
	if (events.length === 0) return running ? [theme.fg("muted", "      waiting for first event")] : [];
	const visible = events.slice(-20);
	const skipped = events.length - visible.length;
	const lines = skipped > 0 ? [theme.fg("muted", `      ... ${skipped} earlier events`)] : [];
	for (const event of visible) {
		if (event.type === "tool") {
			const args = formatArgs(event.args);
			lines.push(`      ${theme.fg("accent", "→")} ${theme.fg("text", event.name)}${args === "" ? "" : ` ${theme.fg("muted", args)}`}`);
		} else {
			lines.push(theme.fg("text", `      ${truncate(compactWhitespace(event.text), 600)}`));
		}
	}
	return lines;
}

function visibleEvents(result: SubagentRunResult): RenderEvent[] {
	const output = compactWhitespace(result.output ?? "");
	if (output === "") return result.events;
	return result.events.filter((event) => event.type !== "text" || compactWhitespace(event.text) !== output);
}

function formatField(label: string, value: string, theme: Pick<Theme, "fg">, color: "accent" | "text" = "text"): string {
	return `    ${theme.fg("muted", label.padEnd(8))}${theme.fg(color, cleanText(value))}`;
}

function formatSection(label: string, theme: Pick<Theme, "fg" | "bold">): string {
	return `    ${theme.fg("muted", theme.bold(label))}`;
}

function indentBlock(value: string, theme: Pick<Theme, "fg">, color: "error" | "text", maxChars: number): string {
	return truncate(cleanText(value), maxChars)
		.split(/\r?\n/)
		.map((line) => theme.fg(color, `      ${line}`))
		.join("\n");
}

function displayPath(value: string): string {
	const home = os.homedir();
	if (value === home) return "~";
	return value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function displayOutputFile(result: SubagentRunResult): string {
	const outputFile = result.outputFile;
	if (outputFile === undefined) return "";
	const relative = path.relative(result.cwd, outputFile);
	if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	return displayPath(outputFile);
}

function commandBackground(result: SubagentToolResult, isPartial: boolean, theme: Theme): (text: string) => string {
	if (isPartial) return (text) => theme.bg("toolPendingBg", text);
	const failed = result.details.results.length === 0 || result.details.results.some((item) => item.error !== undefined);
	return failed ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
}

function formatArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	if (text === undefined || text === "{}") return "";
	return truncateEnd(compactWhitespace(text), 120);
}

function formatAgentNames(agents: string[]): string {
	const unique = [...new Set(agents.filter((agent) => agent.trim() !== ""))];
	if (unique.length === 0) return "preparing";
	if (unique.length <= 3) return unique.join(", ");
	return `${unique.slice(0, 3).join(", ")} +${unique.length - 3}`;
}

function formatTaskSummary(tasks: Array<Pick<SubagentTask, "agent" | "task">>): string {
	if (tasks.length === 0) return "preparing";
	if (tasks.length === 1) return tasks[0]?.task ?? "preparing";
	return tasks.map((task) => `${task.agent}: ${task.task}`).join(" | ");
}

function taskPreviewFromRecord(task: unknown): Pick<SubagentTask, "agent" | "task"> {
	if (!isRecord(task)) return { agent: "?", task: "preparing" };
	const agent = typeof task["agent"] === "string" ? task["agent"] : "?";
	const text = typeof task["task"] === "string" ? task["task"] : "preparing";
	return { agent, task: text };
}

function sumUsage(results: SubagentRunResult[]): UsageStats {
	return results.reduce<UsageStats>((sum, item) => ({
		input: sum.input + item.usage.input,
		output: sum.output + item.usage.output,
		cacheRead: sum.cacheRead + item.usage.cacheRead,
		cacheWrite: sum.cacheWrite + item.usage.cacheWrite,
		contextTokens: sum.contextTokens + item.usage.contextTokens,
		turns: sum.turns + item.usage.turns,
		...(sum.cost !== undefined || item.usage.cost !== undefined ? { cost: (sum.cost ?? 0) + (item.usage.cost ?? 0) } : {}),
	}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 });
}

function totalTokens(usage: UsageStats): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

function truncate(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

function isDetails(value: unknown): value is SubagentDetails {
	return isRecord(value) && (value["mode"] === "parallel" || value["mode"] === "chain") && Array.isArray(value["results"]) && Array.isArray(value["tasks"]);
}

function isToolResult(value: unknown): value is SubagentToolResult {
	return isRecord(value) && Array.isArray(value["content"]) && isDetails(value["details"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
