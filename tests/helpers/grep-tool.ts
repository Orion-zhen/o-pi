import { GrepTool } from "../../src/harness/file-tools/grep/command.ts";
import type { GrepParams, GrepSuccess } from "../../src/harness/file-tools/grep/types.ts";
import { bindFileLsp } from "../../src/harness/file-tools/pi/lsp.ts";
import { FileToolsHost } from "../../src/harness/file-tools/runtime/host.ts";
import { isFailed, type ToolOutcome } from "../../src/harness/file-tools/shared/result.ts";
import type { LspFileOperations } from "../../src/harness/lsp/file-operations.ts";

import { lspOperations } from "./lsp.ts";

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
