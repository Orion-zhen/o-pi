import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { formatChars, joinParts } from "../../../tui/text.js";
import { isEditSuccess, isFailedEdit } from "../../edit/guards.js";
import type { EditPreviewSuccess } from "../../edit/types.js";
import type { FailedResult } from "../../shared/result.js";
import { isPlainRecord } from "../../pi/guards.js";
import { isMutationProgress, type MutationPostProcessProgressDetails } from "../../pi/progress.js";
import { formatDiffStats, formatEditDiagnostics, formatLspSummary, formatMutationPostProcessSummary } from "./diagnostics.js";
import { formatFailureCard } from "./shared.js";

type EditPreview = EditPreviewSuccess | FailedResult;

class EditCallComponent extends Box {
	preview: EditPreview | undefined;
	previewArgsKey: string | undefined;
	previewPending = false;
	settledError = false;
	phase: "editing" = "editing";
	postProcess: MutationPostProcessProgressDetails | undefined;
	progressDiff: string | undefined;

	constructor() {
		super(1, 1);
	}
}

interface EditCallContext {
	lastComponent?: unknown;
	state: { callComponent?: EditCallComponent };
	argsComplete: boolean;
	cwd: string;
	expanded: boolean;
	isPartial: boolean;
	invalidate(): void;
}

interface EditResultContext {
	lastComponent?: unknown;
	state: { callComponent?: EditCallComponent };
	args: unknown;
}

export function renderEditCall(args: unknown, theme: Theme, context: EditCallContext): Text | EditCallComponent {
	if (context.isPartial === false) return new Text("", 0, 0);
	const component = getEditCallComponent(context.state, context.lastComponent);
	const argsKey = stableArgsKey(args);
	if (component.previewArgsKey !== argsKey) {
		component.preview = undefined;
		component.previewArgsKey = argsKey;
		component.previewPending = false;
		component.settledError = false;
		component.phase = "editing";
		component.postProcess = undefined;
		component.progressDiff = undefined;
	}
	if (context.argsComplete && argsKey !== undefined && component.preview === undefined && !component.previewPending) {
		component.previewPending = true;
		void import("../../pi/adapters/edit.js")
			.then(({ previewEditWorkspace }) => previewEditWorkspace(context.cwd, args))
			.catch(previewException)
			.then((preview) => {
				if (component.previewArgsKey === argsKey) {
					component.preview = preview;
					component.previewPending = false;
					context.invalidate();
				}
			});
	}
	return buildEditCallComponent(component, args, theme, context.expanded);
}

export function renderEditResult(
	result: { details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: EditResultContext,
): Text | Box {
	const details = result.details;
	const callComponent = getEditCallComponent(context.state, undefined);
	if (options.isPartial) {
		if (isMutationProgress(details)) {
			if (details.status === "editing") callComponent.postProcess = undefined;
			else if (details.status === "post-processing") callComponent.postProcess = details;
			if (details.diff !== undefined) callComponent.progressDiff = details.diff;
		}
		buildEditCallComponent(callComponent, context.args, theme, options.expanded);
		return new Text("", 0, 0);
	}

	if (isFailedEdit(details)) {
		callComponent.settledError = true;
	}
	buildEditCallComponent(callComponent, context.args, theme, options.expanded);

	const component = context.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1);
	component.clear();
	component.setBgFn(editResultBg(details, theme));
	const output = formatEditResult(details, theme, context.args, options.expanded);
	if (output === undefined) return component;
	component.addChild(new Text(output, 0, 0));
	return component;
}

function getEditCallComponent(state: { callComponent?: EditCallComponent }, lastComponent: unknown): EditCallComponent {
	if (lastComponent instanceof EditCallComponent) {
		state.callComponent = lastComponent;
		return lastComponent;
	}
	if (state.callComponent !== undefined) return state.callComponent;
	const component = new EditCallComponent();
	state.callComponent = component;
	return component;
}

function buildEditCallComponent(component: EditCallComponent, args: unknown, theme: Theme, expanded: boolean): EditCallComponent {
	component.setBgFn(editHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(component, args, theme), 0, 0));
	if (!expanded) return component;
	if (component.preview !== undefined && isFailedEdit(component.preview)) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", formatEditError(component.preview)), 0, 0));
		return component;
	}
	const diff = component.progressDiff ?? component.preview?.diff;
	if (diff !== undefined && diff !== "") {
		component.addChild(new Spacer(1));
		component.addChild(new Text(renderDiff(diff), 0, 0));
	}
	return component;
}

function editHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean,
	theme: Theme,
): ((text: string) => string) | undefined {
	if (preview !== undefined && isFailedEdit(preview)) return (text) => theme.bg("toolErrorBg", text);
	if (settledError) return (text) => theme.bg("toolErrorBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function editResultBg(details: unknown, theme: Theme): (text: string) => string {
	if (isFailedEdit(details)) return (text) => theme.bg("toolErrorBg", text);
	if (isEditSuccess(details)) return (text) => theme.bg("toolSuccessBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function formatEditResult(details: unknown, theme: Theme, args: unknown, expanded: boolean): string | undefined {
	if (isFailedEdit(details)) return formatFailureCard("edit", editTarget(args), details, args, expanded, theme);
	if (!isEditSuccess(details)) return undefined;
	const header = formatToolCard({
		tool: "edit",
		status: "success",
		target: details.path,
		summary: joinParts(["done", formatDiffStats(details.diff), `${details.replacements} replacements`, formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const diff = details.diff === "" ? undefined : renderDiff(details.diff);
	if (!expanded) return header;
	const diagnostics = formatEditDiagnostics(details.lsp?.diagnostics, theme);
	return [header, diff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function stableArgsKey(args: unknown): string | undefined {
	if (!isPlainRecord(args) || typeof args["path"] !== "string" || !Array.isArray(args["edits"]) || args["edits"].length === 0) {
		return undefined;
	}
	if (!args["edits"].every((edit) => isPlainRecord(edit)
		&& typeof edit["old"] === "string"
		&& edit["old"].length > 0
		&& typeof edit["new"] === "string")) {
		return undefined;
	}
	return JSON.stringify({ path: args["path"], edits: args["edits"] });
}

function formatEditError(result: FailedResult): string {
	return `${result.error.code}: ${result.error.message}`;
}

function previewException(error: unknown): FailedResult {
	return {
		status: "failed",
		error: {
			code: "INVALID_OPERATION",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

function formatEditCall(component: EditCallComponent, args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const input = editInputStats(args);
	const diff = component.progressDiff ?? (component.preview !== undefined && !isFailedEdit(component.preview) ? component.preview.diff : undefined);
	return formatToolCard({
		tool: "edit",
		status: "running",
		target: editTarget(args),
		summary: joinParts([
			component.postProcess === undefined ? component.phase : formatMutationPostProcessSummary(component.postProcess),
			diff === undefined ? undefined : formatDiffStats(diff),
			input === undefined ? undefined : `${input.replacements} replacements`,
			input === undefined ? undefined : `${input.lines} lines`,
			input === undefined ? undefined : formatChars(input.chars),
		]),
	}, theme);
}

interface EditInputStats {
	replacements: number;
	lines: number;
	chars: number;
}

function editInputStats(args: unknown): EditInputStats | undefined {
	if (!isPlainRecord(args) || !Array.isArray(args["edits"])) return undefined;
	let lines = 0;
	let chars = 0;
	for (const edit of args["edits"]) {
		if (!isPlainRecord(edit)) continue;
		for (const key of ["old", "new"] as const) {
			const value = edit[key];
			if (typeof value !== "string") continue;
			chars += value.length;
			lines += value === "" ? 0 : value.split(/\r\n?|\n/).length;
		}
	}
	return { replacements: args["edits"].length, lines, chars };
}

function editTarget(args: unknown): string {
	return isPlainRecord(args) && typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : "file";
}
