import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../tui/tool-card.js";
import { formatChars, joinParts } from "../../tui/text.js";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails, type SkillToolErrorDetails } from "../types.js";

interface SkillRenderContext {
	args?: unknown;
	isPartial?: boolean;
	lastComponent?: unknown;
}

export function registerSkillMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	pi.registerMessageRenderer<SkillLoadDetails>(SKILL_CONTEXT_MESSAGE, (message, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(formatSkillSuccess(message.details, expanded, theme, true), 0, 0));
		return box;
	});
}

export function renderSkillCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: SkillRenderContext = {}): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(context.isPartial === false
		? ""
		: formatToolCard({ tool: "skill", status: "running", target: skillNameFromArgs(args), summary: "loading" }, theme));
	return text;
}

export function renderSkillResult(
	details: unknown,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: SkillRenderContext = {},
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	if (isSkillLoadDetails(details)) {
		text.setText(formatSkillSuccess(details, options.expanded === true, theme, false));
	} else if (isSkillToolErrorDetails(details)) {
		text.setText(formatToolCard({
			tool: "skill",
			status: "error",
			target: skillNameFromArgs(context.args),
			summary: `${details.error.code}: ${details.error.message}`,
		}, theme));
	} else {
		text.setText(formatToolCard({ tool: "skill", status: options.isPartial ? "running" : "neutral", target: skillNameFromArgs(context.args), summary: "loading" }, theme));
	}
	return text;
}

function formatSkillSuccess(
	details: SkillLoadDetails | undefined,
	expanded: boolean,
	theme: Pick<Theme, "fg" | "bold">,
	includeLoadedBy: boolean,
): string {
	const deduplicated = details?.deduplicated === true;
	const summary = joinParts([
		deduplicated ? "already loaded" : "loaded",
		details?.scope,
		includeLoadedBy ? details?.loadedBy : undefined,
		details === undefined ? undefined : formatChars(details.chars),
	]);
	const card = formatToolCard({
		tool: "skill",
		status: deduplicated ? "warning" : "success",
		target: details?.name ?? "skill",
		summary,
	}, theme);
	if (!expanded || details === undefined) return card;
	return `${card}\n\n  Root            ${details.root}\n  Content hash    ${details.contentHash}`;
}

function skillNameFromArgs(value: unknown): string {
	if (typeof value !== "object" || value === null || !("name" in value)) return "...";
	return typeof value.name === "string" && value.name.trim() !== "" ? value.name : "...";
}

function isSkillLoadDetails(value: unknown): value is SkillLoadDetails {
	return typeof value === "object" && value !== null && "deduplicated" in value && typeof value.deduplicated === "boolean";
}

function isSkillToolErrorDetails(value: unknown): value is SkillToolErrorDetails {
	if (typeof value !== "object" || value === null || !("status" in value) || value.status !== "failed" || !("error" in value)) return false;
	const error = value.error;
	return typeof error === "object" && error !== null
		&& "code" in error && typeof error.code === "string"
		&& "message" in error && typeof error.message === "string";
}
