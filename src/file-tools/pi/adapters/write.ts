import { writeFile } from "../../write/command.js";
import type { WriteParams, WritePreviewSuccess } from "../../write/types.js";
import type { FileToolsHost } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import { formatWriteModelResult } from "../../write/presenter.js";
import { formatErrorModelResult } from "../model-output.js";
import { createWritePorts } from "../ports/write.js";
import { piTextDiffGenerator } from "../ports/text-diff.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { MutationBatchInvocation } from "../mutation-batch.js";
import { createMutationPostProcessObserver, mutationProgress, type MutationProgressCallback } from "../progress.js";

export async function executeWrite(
	params: WriteParams,
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
		let latestPreview: WritePreviewSuccess | undefined;
		const progress = createMutationPostProcessObserver(runtime.onUpdate, () => (
			latestPreview === undefined ? {} : { diff: latestPreview.diff }
		));
		const ports = createWritePorts(opened, runtime.lsp, progress, runtime.batch);
		const result = await writeFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			maxFileBytes: opened.limits.write_max_file_bytes,
			diff: piTextDiffGenerator,
			diagnostics: ports.diagnostics,
			onPrepared(preview) {
				latestPreview = preview;
				runtime.onUpdate?.(mutationProgress({ status: "writing", diff: preview.diff }));
			},
		});
		if (isFailed(result)) return failedResult(result);
		return {
			content: [{ type: "text" as const, text: formatWriteModelResult(result) }],
			details: result,
		};
	} finally {
		opened.dispose();
	}
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
