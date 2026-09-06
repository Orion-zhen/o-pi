import type { LoadLsp } from "../../../lsp/file-operations.js";
import { GrepTool, formatCompactGrepResult } from "../../grep/command.js";
import type { GrepParams } from "../../grep/types.js";
import { isFailed } from "../../shared/result.js";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.js";
import { bindFileLsp } from "../lsp.js";

export interface ExecuteGrepOptions extends FileToolRuntime {
	readonly lsp: LoadLsp;
}

export function createGrepAdapter() {
	const tool = new GrepTool();
	return {
		async execute(params: GrepParams, options: ExecuteGrepOptions) {
			return withFileToolsInvocation(options, async (opened) => {
				const result = await tool.execute(params, {
					...opened,
					...bindFileLsp(opened, options.lsp),
				});
				if (isFailed(result)) return result;
				return { content: [{ type: "text" as const, text: formatCompactGrepResult(result) }], details: result };
			});
		},
		dispose() {
			tool.dispose();
		},
	};
}
