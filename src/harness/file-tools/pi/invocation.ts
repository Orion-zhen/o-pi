import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { FilesystemPathAccess } from "../../filesystem/contracts/access.ts";
import type { LoadLsp } from "../../lsp/file-operations.ts";
import type { FileToolsHost, FileToolsHostOpenOptions, FileToolsInvocation } from "../runtime/host.ts";
import { isFailed, type FailedResult, type ToolOutcome } from "../shared/result.ts";
import { formatErrorModelResult } from "./model-output.ts";
import type { MutationBatchInvocation } from "./mutation-batch.ts";
import type { MutationProgressCallback } from "./progress.ts";

export interface FileToolRuntime extends FileToolsHostOpenOptions {
	readonly host: FileToolsHost;
	readonly pathAccess: FilesystemPathAccess;
}

export interface MutationRuntime extends FileToolRuntime {
	readonly lsp: LoadLsp;
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
