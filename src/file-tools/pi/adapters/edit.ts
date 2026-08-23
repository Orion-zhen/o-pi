import { editFile, previewEdit } from "../../edit/command.js";
import type { EditParams, EditPreviewSuccess } from "../../edit/types.js";
import { FileToolsHost, type FileToolsInvocation } from "../../runtime/host.js";
import { fail, isFailed } from "../../shared/result.js";
import { isPlainRecord } from "../guards.js";
import type { LspFileOperations } from "../../../lsp/index.js";
import { formatEditModelResult } from "../../edit/presenter.js";
import { formatErrorModelResult } from "../model-output.js";
import { createMutationDiagnosticsSource } from "../ports/mutation-diagnostics.js";
import { piTextDiffGenerator } from "../ports/text-diff.js";
import type { MutationBatchInvocation } from "../mutation-batch.js";
import { createMutationPostProcessObserver, mutationProgress, type MutationProgressCallback } from "../progress.js";

export async function executeEdit(
	params: EditParams,
	runtime: {
		cwd: string;
		sessionId: string;
		signal?: AbortSignal;
		host: FileToolsHost;
		lsp: LspFileOperations;
		onUpdate?: MutationProgressCallback;
		batch?: MutationBatchInvocation;
	},
) {
	const opened = await runtime.host.open({
		cwd: runtime.cwd,
		sessionId: runtime.sessionId,
		...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		let latestPreview: EditPreviewSuccess | undefined;
		const progress = createMutationPostProcessObserver(runtime.onUpdate, () => ({
			replacements: latestPreview?.replacements ?? params.edits.length,
			...(latestPreview === undefined ? {} : { diff: latestPreview.diff }),
		}));
		const diagnostics = createMutationDiagnosticsSource(opened, runtime.lsp, progress, runtime.batch);
		const result = await editFile(params, commandContext(opened, diagnostics, (preview) => {
			latestPreview = preview;
			runtime.onUpdate?.(mutationProgress({ status: "editing", diff: preview.diff, replacements: preview.replacements }));
		}));
		const text = isFailed(result) ? formatErrorModelResult(result) : formatEditModelResult(result);
		return { content: [{ type: "text" as const, text }], details: result };
	} finally {
		opened.dispose();
	}
}

/** Renderer-only preview entry; owns and disposes its short-lived read-only host. */
export async function previewEditWorkspace(cwd: string, params: unknown) {
	if (!isEditPreviewParams(params)) return fail("INVALID_OPERATION", "edit preview input is incomplete.");
	const host = new FileToolsHost();
	try {
		const opened = await host.open({ cwd, sessionId: "renderer-preview" });
		if (isFailed(opened)) return opened;
		try {
			return await previewEdit(params, {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxFileBytes: opened.limits.edit_max_file_bytes,
				matchHintLimit: opened.limits.edit_match_hint_limit,
				diff: piTextDiffGenerator,
			});
		} finally {
			opened.dispose();
		}
	} finally {
		host.dispose();
	}
}

function isEditPreviewParams(value: unknown): value is EditParams {
	if (!isPlainRecord(value) || typeof value["path"] !== "string" || !Array.isArray(value["edits"]) || value["edits"].length === 0) {
		return false;
	}
	return value["edits"].every((edit) => isPlainRecord(edit)
		&& typeof edit["old"] === "string"
		&& edit["old"].length > 0
		&& typeof edit["new"] === "string"
		&& (edit["replace_all"] === undefined || typeof edit["replace_all"] === "boolean"));
}

function commandContext(
	opened: FileToolsInvocation,
	diagnostics: ReturnType<typeof createMutationDiagnosticsSource>,
	onPrepared: (preview: EditPreviewSuccess) => void,
) {
	return {
		filesystem: opened.filesystem,
		operation: opened.context,
		observation: opened.observation,
		maxFileBytes: opened.limits.edit_max_file_bytes,
		matchHintLimit: opened.limits.edit_match_hint_limit,
		diff: piTextDiffGenerator,
		diagnostics,
		onPrepared,
	};
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
