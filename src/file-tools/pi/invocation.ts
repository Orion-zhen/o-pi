import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { FilesystemPathAccess } from "../../filesystem/contracts/access.js";
import type { LspFileOperations } from "../../lsp/index.js";
import type { FileToolsHost, FileToolsHostOpenOptions, FileToolsInvocation } from "../runtime/host.js";
import { isFailed, type FailedResult, type ToolOutcome } from "../shared/result.js";
import { formatErrorModelResult } from "./model-output.js";
import type { MutationBatchInvocation } from "./mutation-batch.js";
import type { MutationProgressCallback } from "./progress.js";

export interface FileToolRuntime extends FileToolsHostOpenOptions {
	readonly host: FileToolsHost;
	readonly pathAccess: FilesystemPathAccess;
}

export interface MutationRuntime extends FileToolRuntime {
	readonly lsp: LspFileOperations;
	readonly onUpdate?: MutationProgressCallback;
	readonly batch?: MutationBatchInvocation;
}

/** Pi 调用的唯一租约边界，命令失败和打开失败使用同一结果转换。 */
export async function withFileToolsInvocation<T>(
	runtime: FileToolRuntime,
	execute: (opened: FileToolsInvocation) => Promise<ToolOutcome<AgentToolResult<T>>>,
): Promise<AgentToolResult<T | FailedResult>> {
	const opened = await runtime.host.open(runtime);
	if (isFailed(opened)) return failedToolResult(opened);
	try {
		const result = await execute(opened);
		return isFailed(result) ? failedToolResult(result) : result;
	} finally {
		opened.dispose();
	}
}

export function failedToolResult(result: FailedResult): AgentToolResult<FailedResult> {
	return { content: [{ type: "text", text: formatErrorModelResult(result) }], details: result };
}
