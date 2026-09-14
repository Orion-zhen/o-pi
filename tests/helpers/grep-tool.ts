import { GrepTool } from "../../src/harness/file-tools/grep/command.js";
import type { GrepParams, GrepSuccess } from "../../src/harness/file-tools/grep/types.js";
import { bindFileLsp } from "../../src/harness/file-tools/pi/lsp.js";
import { FileToolsHost } from "../../src/harness/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/harness/file-tools/shared/result.js";
import type { LspFileOperations } from "../../src/harness/lsp/file-operations.js";

import { lspOperations } from "./lsp.js";

let host = new FileToolsHost();
let tool = new GrepTool();

export interface GrepTestRuntime {
	readonly lsp?: Partial<LspFileOperations>;
}

export async function grepWorkspaceFiles(
	cwd: string,
	params: GrepParams,
	signal?: AbortSignal,
	runtime: GrepTestRuntime = {},
): Promise<ToolOutcome<GrepSuccess>> {
	const opened = await host.open({ cwd, sessionId: "grep-test", ...(signal === undefined ? {} : { signal }) });
	if (isFailed(opened)) return opened;
	const lsp = runtime.lsp === undefined ? undefined : lspOperations(runtime.lsp);
	try {
			return await tool.execute(params, {
				...opened,
				...(lsp === undefined ? {} : bindFileLsp(opened, async () => lsp)),
			});
	} finally { opened.dispose(); }
}

export function clearGrepTestRuntime(): void {
	tool.dispose();
	host.dispose();
	tool = new GrepTool();
	host = new FileToolsHost();
}
