import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../tui/tool-card.js";
import { joinParts } from "../../../tui/text.js";
import type { EditPreviewSuccess, EditSuccess } from "../../types.js";
import type { FailedResult } from "../../shared/result.js";
import { isEditSuccessDetails, isFailedEditDetails, isPlainRecord } from "../guards.js";
import { formatDiffStats, formatLspDiagnostics, formatLspSummary } from "./diagnostics.js";
import { formatFailureCard } from "./shared.js";

type EditPreview = EditPreviewSuccess | FailedResult;

class EditCallComponent extends Box {
	preview: EditPreview | EditSuccess | undefined;
	previewArgsKey: string | undefined;
	previewPending = false;
	settledError = false;

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
	}
	if (context.argsComplete && argsKey !== undefined && component.preview === undefined && !component.previewPending) {
		component.previewPending = true;
		void import("../../tools/edit.js")
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
	if (options.isPartial) return new Text(formatToolCard({ tool: "edit", status: "running", target: editTarget(context.args), summary: "applying" }, theme), 0, 0);

	const details = result.details;
	const callComponent = getEditCallComponent(context.state, undefined);
	if (isEditSuccessDetails(details)) {
		callComponent.preview = details;
		callComponent.previewArgsKey = stableArgsKey(context.args);
		callComponent.previewPending = false;
		callComponent.settledError = false;
	} else if (isFailedEditDetails(details)) {
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
	component.addChild(new Text(formatEditCall(args, theme), 0, 0));
	if (!expanded || component.preview === undefined) return component;

	component.addChild(new Spacer(1));
	if (isFailedEditDetails(component.preview)) {
		component.addChild(new Text(theme.fg("error", formatEditError(component.preview)), 0, 0));
	} else if (component.preview.diff !== "") {
		component.addChild(new Text(renderDiff(component.preview.diff), 0, 0));
	}
	return component;
}

function editHeaderBg(
	preview: EditPreview | EditSuccess | undefined,
	settledError: boolean,
	theme: Theme,
): ((text: string) => string) | undefined {
	if (preview !== undefined) {
		return isFailedEditDetails(preview) ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text) => theme.bg("toolErrorBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function editResultBg(details: unknown, theme: Theme): (text: string) => string {
	if (isFailedEditDetails(details)) return (text) => theme.bg("toolErrorBg", text);
	if (isEditSuccessDetails(details)) return (text) => theme.bg("toolSuccessBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function formatEditResult(details: unknown, theme: Theme, args: unknown, expanded: boolean): string | undefined {
	if (isFailedEditDetails(details)) return formatFailureCard("edit", editTarget(args), details, args, expanded, theme);
	if (!isEditSuccessDetails(details)) return undefined;
	const header = formatToolCard({
		tool: "edit",
		status: "success",
		target: details.path,
		summary: joinParts([formatDiffStats(details.diff), `${details.replacements} replacements`, details.diff !== "" ? "diff available" : "no diff", formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	const diff = details.diff === "" ? undefined : renderDiff(details.diff);
	if (!expanded) return header;
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return [header, diff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function stableArgsKey(args: unknown): string | undefined {
	if (!isPlainRecord(args) || typeof args["path"] !== "string" || !Array.isArray(args["edits"])) return undefined;
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

function formatEditCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const replacements = isPlainRecord(args) && Array.isArray(args["edits"]) ? args["edits"].length : undefined;
	return formatToolCard({
		tool: "edit",
		status: "running",
		target: editTarget(args),
		summary: joinParts(["previewing", replacements !== undefined ? `${replacements} replacements` : undefined]),
	}, theme);
}

function editTarget(args: unknown): string {
	return isPlainRecord(args) && typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : "file";
}
