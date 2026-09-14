import { writeFile } from "../../write/command.ts";
import type { WriteParams, WritePreviewSuccess } from "../../write/types.ts";
import { isFailed } from "../../shared/result.ts";
import { formatWriteModelResult } from "../../write/presenter.ts";
import { withFileToolsInvocation, type MutationRuntime } from "../invocation.ts";
import { bindFileLsp } from "../lsp.ts";
import { piTextDiffGenerator } from "../ports/text-diff.ts";
import { createMutationPostProcessObserver, mutationProgress } from "../progress.ts";

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
