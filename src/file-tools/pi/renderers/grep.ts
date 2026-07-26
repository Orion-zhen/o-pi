import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { formatGrepCall, formatGrepResult } from "../../grep/renderer.js";
import { isPlainRecord } from "../guards.js";
import type { ToolTextResult } from "./contracts.js";
import { formatFailureCard, pathArgs, textComponent } from "./shared.js";

export function renderGrepCall(
	args: unknown,
	theme: Pick<Theme, "fg" | "bold">,
	context: { lastComponent?: unknown; isPartial?: boolean },
): Text {
	const text = textComponent(context.lastComponent);
	text.setText(context.isPartial === false ? "" : formatGrepCall(args, theme));
	return text;
}

export function renderGrepResult(
	result: ToolTextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: { lastComponent?: unknown; args?: unknown },
): Text {
	const text = textComponent(context.lastComponent);
	if (options.isPartial) {
		text.setText(formatToolCard({ tool: "grep", status: "running", target: grepTarget(context.args), summary: "searching files" }, theme));
		return text;
	}
	text.setText(formatFailureCard("grep", grepTarget(context.args), result.details, context.args, options.expanded, theme) ?? formatGrepResult(result.details, options.expanded, theme));
	return text;
}

function grepTarget(args: unknown): string {
	const record = isPlainRecord(args) ? args : {};
	const query = typeof record["query"] === "string" ? JSON.stringify(record["query"]) : "?";
	const scope = pathArgs(record["path"]).join(", ");
	return `${query} in ${scope}`;
}
