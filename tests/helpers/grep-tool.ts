import { GrepTool } from "../../src/file-tools/grep/command.js";
import type { GrepParams, GrepSuccess } from "../../src/file-tools/grep/types.js";
import { createGrepGraphSource, createGrepSymbolSource } from "../../src/file-tools/pi/adapters/grep.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { LspFileOperations } from "../../src/lsp/file-hooks.js";
import type { RepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";

let host = new FileToolsHost();
let tool = new GrepTool();

export interface GrepTestRuntime {
	readonly lsp?: LspFileOperations;
	readonly repoMap?: RepoMapFileToolQuery;
}

export async function grepWorkspaceFiles(
	cwd: string,
	params: GrepParams,
	signal?: AbortSignal,
	runtime: GrepTestRuntime = {},
): Promise<ToolOutcome<GrepSuccess>> {
	const opened = await host.open({ cwd, sessionId: "grep-test", ...(signal === undefined ? {} : { signal }) });
	if (isFailed(opened)) return opened;
	try {
		return await tool.execute(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
			...(runtime.lsp === undefined ? {} : { symbols: createGrepSymbolSource(runtime.lsp, opened) }),
			...(runtime.repoMap === undefined ? {} : {
				graph: createGrepGraphSource({
					query: runtime.repoMap,
					async formatReadContext() { return undefined; },
					async formatImpact() { return undefined; },
				}, opened),
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
