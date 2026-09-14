import { editFile, previewEdit } from "../../edit/command.ts";
import type { EditParams, EditPreviewSuccess } from "../../edit/types.ts";
import { FileToolsHost } from "../../runtime/host.ts";
import { fail, isFailed } from "../../shared/result.ts";
import { isPlainRecord } from "../guards.ts";
import { formatEditModelResult } from "../../edit/presenter.ts";
import { withFileToolsInvocation, type MutationRuntime } from "../invocation.ts";
import { bindFileLsp } from "../lsp.ts";
import { piTextDiffGenerator } from "../ports/text-diff.ts";
import { createMutationPostProcessObserver, mutationProgress } from "../progress.ts";

export async function executeEdit(
	params: EditParams,
	runtime: MutationRuntime,
) {
	return withFileToolsInvocation(runtime, async (opened) => {
		let latestPreview: EditPreviewSuccess | undefined;
		const progress = createMutationPostProcessObserver(runtime.onUpdate, () => ({
			replacements: latestPreview?.replacements ?? params.edits.length,
			...(latestPreview === undefined ? {} : { diff: latestPreview.diff }),
		}));
		const diagnostics = bindFileLsp(opened, runtime.lsp).diagnostics(progress, runtime.batch);
		const result = await editFile(params, {
			...opened,
			diagnostics,
			diff: piTextDiffGenerator,
			onPrepared(preview) {
				latestPreview = preview;
				runtime.onUpdate?.(mutationProgress({ status: "editing", diff: preview.diff, replacements: preview.replacements }));
			},
		});
		if (isFailed(result)) return result;
		return { content: [{ type: "text", text: formatEditModelResult(result) }], details: result };
	});
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
				...opened,
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
