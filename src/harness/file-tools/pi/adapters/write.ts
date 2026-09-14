import { writeFile } from "../../write/command.js";
import type { WriteParams, WritePreviewSuccess } from "../../write/types.js";
import { isFailed } from "../../shared/result.js";
import { formatWriteModelResult } from "../../write/presenter.js";
import { withFileToolsInvocation, type MutationRuntime } from "../invocation.js";
import { bindFileLsp } from "../lsp.js";
import { piTextDiffGenerator } from "../ports/text-diff.js";
import { createMutationPostProcessObserver, mutationProgress } from "../progress.js";

export async function executeWrite(params: WriteParams, runtime: MutationRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		let latestPreview: WritePreviewSuccess | undefined;
		const progress = createMutationPostProcessObserver(runtime.onUpdate, () => (
			latestPreview === undefined ? {} : { diff: latestPreview.diff }
		));
		const diagnostics = bindFileLsp(opened, runtime.lsp).diagnostics(progress, runtime.batch);
		const result = await writeFile(params, {
			...opened,
			diff: piTextDiffGenerator,
			diagnostics,
			onPrepared(preview) {
				latestPreview = preview;
				runtime.onUpdate?.(mutationProgress({ status: "writing", diff: preview.diff }));
			},
		});
		if (isFailed(result)) return result;
		return { content: [{ type: "text", text: formatWriteModelResult(result) }], details: result };
	});
}
