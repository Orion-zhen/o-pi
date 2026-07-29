import { GrepTool, formatCompactGrepResult } from "../../grep/command.js";
import type { GrepHintSource, GrepPositionHint } from "../../grep/ports.js";
import type { GrepParams } from "../../grep/types.js";
import type { FileToolsHost, FileToolsInvocation } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import { formatErrorModelResult } from "../model-output.js";

export interface ExecuteGrepOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly lsp: LspFileOperations;
}

export function createGrepAdapter() {
	const tool = new GrepTool();
	return {
		async execute(params: GrepParams, options: ExecuteGrepOptions) {
			const opened = await options.host.open({
				cwd: options.cwd,
				sessionId: options.sessionId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			if (isFailed(opened)) return failedResult(opened);
			try {
				const result = await tool.execute(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					limits: opened.limits,
					lspHints: createLspGrepHintSource(options.lsp, opened),
				});
				if (isFailed(result)) return failedResult(result);
				return { content: [{ type: "text" as const, text: formatCompactGrepResult(result) }], details: result };
			} finally {
				opened.dispose();
			}
		},
		dispose() {
			tool.dispose();
		},
	};
}

export function createLspGrepHintSource(lsp: LspFileOperations, invocation: FileToolsInvocation): GrepHintSource {
	return {
		async query(input) {
			if (input.signal?.aborted === true || lsp.symbols === undefined) return [];
			const workspace = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			if (workspace === undefined) return [];
			const candidates = await lsp.symbols({
				workspaceRoot: workspace.nativePath,
				query: input.query,
				allowedPaths: new Set(input.allowedPaths),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			return candidates
				.map((candidate): GrepPositionHint => ({
				path: candidate.path,
				range: { startLine: candidate.start_line, endLine: candidate.end_line },
				origin: "lsp-symbol",
				confidence: candidate.exact ? 1 : 0.8,
				reasons: [candidate.exact ? "lsp exact symbol" : "lsp symbol"],
				}));
		},
	};
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
