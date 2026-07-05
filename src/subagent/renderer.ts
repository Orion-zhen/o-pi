import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails, SubagentRunResult, UsageStats } from "./types.js";

const COLLAPSED_EVENTS = 9;

export function renderSubagentCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): Text {
	const record = isRecord(args) ? args : {};
	const taskCount = Array.isArray(record["tasks"]) ? (record["tasks"] as unknown[]).length : 0;
	const label = record["mode"] === "chain" ? `chain (${taskCount})` : `tasks (${taskCount})`;
	return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", label)}`, 0, 0);
}

export function renderSubagentResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Container | Text {
	const details = isDetails(result.details) ? result.details : undefined;
	if (details === undefined) return new Text(result.content[0]?.text ?? "(no output)", 0, 0);
	const container = new Container();
	if (details.results.length === 0) {
		container.addChild(new Text(result.content[0]?.text ?? "(no output)", 0, 0));
		return container;
	}
	if (details.mode === "parallel") {
		const done = details.results.filter((item) => item.exitCode !== -1).length;
		const failed = details.results.filter((item) => item.error !== undefined).length;
		const running = Math.max(0, details.results.length - done);
		container.addChild(new Text(`${theme.fg(failed > 0 ? "warning" : "success", failed > 0 ? "✗" : "✓")} Subagents ${done}/${details.results.length} complete · ${running} running`, 0, 0));
	} else {
		const first = details.results[0];
		if (first !== undefined) container.addChild(new Text(formatHeader(first, theme), 0, 0));
	}
	for (const item of details.results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(formatHeader(item, theme), 0, 0));
		if (options.expanded) {
			container.addChild(new Text(theme.fg("muted", `task: ${item.task}`), 0, 0));
			container.addChild(new Text(theme.fg("muted", `source: ${item.source} cwd: ${item.cwd}`), 0, 0));
			container.addChild(new Text(theme.fg("muted", `tools: ${item.tools.join(", ")}`), 0, 0));
			if (item.model !== undefined) container.addChild(new Text(theme.fg("muted", `model: ${item.model}`), 0, 0));
			if (item.outputFile !== undefined) container.addChild(new Text(theme.fg("accent", `file: ${item.outputFile}`), 0, 0));
			if (item.stderr !== undefined) container.addChild(new Text(theme.fg("error", truncate(item.stderr, 1600)), 0, 0));
			if (item.output !== undefined) container.addChild(new Text(theme.fg("toolOutput", truncate(item.output, 3000)), 0, 0));
		} else {
			const events = item.events.slice(-COLLAPSED_EVENTS);
			for (const event of events) {
				if (event.type === "tool") container.addChild(new Text(theme.fg("muted", `  ${event.name} ${formatToolArgs(event.args)}`), 0, 0));
			}
			if (item.error !== undefined) container.addChild(new Text(theme.fg("error", `  ${item.error}`), 0, 0));
			else if (item.output !== undefined) container.addChild(new Text(theme.fg("toolOutput", `  ${firstLine(item.output)}`), 0, 0));
		}
	}
	return container;
}

function formatHeader(result: SubagentRunResult, theme: Theme): string {
	const failed = result.error !== undefined;
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const usage = formatUsage(result.usage);
	const parts = [`${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}`, `${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`, `${(result.durationMs / 1000).toFixed(1)}s`];
	if (usage !== "") parts.push(usage);
	return parts.join(" · ");
}

function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turns`);
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
	if (usage.cost !== undefined && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const text = JSON.stringify(args);
	return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function firstLine(text: string): string {
	return truncate(text.trim().split(/\r?\n/)[0] ?? "", 180);
}

function truncate(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

function isDetails(value: unknown): value is SubagentDetails {
	return isRecord(value) && (value["mode"] === "parallel" || value["mode"] === "chain") && Array.isArray(value["results"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
