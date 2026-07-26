import { editFile, previewEdit } from "../../edit/command.js";
import type { EditParams } from "../../edit/types.js";
import { FileToolsHost, type FileToolsInvocation } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import { formatEditModelResult } from "../../edit/presenter.js";
import { formatErrorModelResult, scrubVersions } from "../model-output.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";
import { createEditPorts } from "../ports/edit.js";
import { piTextDiffGenerator } from "../ports/text-diff.js";

export async function executeEdit(
	params: EditParams,
	runtime: {
		cwd: string;
		sessionId: string;
		signal?: AbortSignal;
		host: FileToolsHost;
		lsp: LspFileOperations;
		repoMap: RepoMapToolPorts;
	},
) {
	const opened = await runtime.host.open({
		cwd: runtime.cwd,
		sessionId: runtime.sessionId,
		...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		const ports = createEditPorts(opened, runtime.lsp, runtime.repoMap);
		const result = await editFile(params, commandContext(opened, ports));
		const text = isFailed(result)
			? formatErrorModelResult(result)
			: result.status === "applied"
				? formatEditModelResult(result, ports.impact())
				: JSON.stringify(scrubVersions(result));
		return { content: [{ type: "text" as const, text }], details: result };
	} finally {
		opened.dispose();
	}
}

/** Renderer-only preview entry; owns and disposes its short-lived read-only host. */
export async function previewEditWorkspace(cwd: string, params: unknown) {
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

function commandContext(opened: FileToolsInvocation, ports: ReturnType<typeof createEditPorts>) {
	return {
		filesystem: opened.filesystem,
		operation: opened.context,
		observation: opened.observation,
		maxFileBytes: opened.limits.edit_max_file_bytes,
		matchHintLimit: opened.limits.edit_match_hint_limit,
		diff: piTextDiffGenerator,
		diagnostics: ports.diagnostics,
		mutationObserver: ports.observer,
	};
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
