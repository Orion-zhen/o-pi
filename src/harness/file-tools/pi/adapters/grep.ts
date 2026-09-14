import type { LoadLsp } from "../../../lsp/file-operations.ts";
import { GrepTool, formatCompactGrepResult } from "../../grep/command.ts";
import type { GrepParams } from "../../grep/types.ts";
import { isFailed } from "../../shared/result.ts";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.ts";
import { bindFileLsp } from "../lsp.ts";

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
