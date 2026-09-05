import { GrepTool } from "../../src/file-tools/grep/command.js";
import type { GrepParams, GrepSuccess } from "../../src/file-tools/grep/types.js";
import {
	analyzeCodeWithLsp,
	prepareCodeAnalysisWithLsp,
} from "../../src/file-tools/pi/adapters/grep.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { LspFileOperations } from "../../src/lsp/adapters/file-operations.js";

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
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
				...(lsp === undefined ? {} : {
					prepareCodeAnalysis: (input) => prepareCodeAnalysisWithLsp(lsp, opened, input),
					analyzeCode: (input) => analyzeCodeWithLsp(lsp, opened, input),
				}),
			});
	} finally { opened.dispose(); }
}

export function clearGrepTestRuntime(): void {
	tool.dispose();
	host.dispose();
	tool = new GrepTool();
	host = new FileToolsHost();
}
