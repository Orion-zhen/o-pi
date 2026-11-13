import { writeFile } from "../../write/command.ts";
import type { WriteParams } from "../../write/types.ts";
import { isFailed } from "../../shared/result.ts";
import { formatWriteModelResult } from "../../write/presenter.ts";
import { withFileToolsInvocation, type MutationRuntime } from "../invocation.ts";
import { bindFileLsp } from "../lsp.ts";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { createMutationProgress } from "../progress.ts";

export async function executeWrite(params: WriteParams, runtime: MutationRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		const progress = createMutationProgress(runtime.onUpdate);
		const diagnostics = bindFileLsp(opened, runtime.lsp).diagnostics(progress, runtime.batch);
		const result = await writeFile(params, {
			...opened,
			diff: generateDiffString,
			diagnostics,
			onPrepared(preview) {
				progress.prepared({ status: "writing", diff: preview.diff });
			},
		});
		if (isFailed(result)) return result;
		return { content: [{ type: "text", text: formatWriteModelResult(result) }], details: result };
	});
}
