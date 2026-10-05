import path from "node:path";
import type { AnalyzedFileIndex } from "../../../code-index/types.ts";
import { mergeCodeStructure } from "../../../code-index/structure.ts";
import type { LoadLsp } from "../../../lsp/file-operations.ts";
import type { ReadStructureSource } from "../../read/ports.ts";
import { readStructureContext } from "../../read/structure.ts";
import type { FileToolsInvocation } from "../../runtime/host.ts";

/** 同次 read 的范围和预算重算复用一份组合索引，不重新读取正文。 */
export function createReadStructureSource(invocation: FileToolsInvocation, load: LoadLsp): ReadStructureSource {
	const bridge = invocation.nativeBridge;
	const root = bridge.root;
	const maxSymbols = invocation.limits.read_outline_symbols;
	let pending: Promise<AnalyzedFileIndex | undefined> | undefined;
	return {
		async context(input) {
			if (!input.partial && (!input.truncated || maxSymbols === 0)) return undefined;
			pending ??= analyze();
			const analysis = await pending;
			return analysis === undefined ? undefined : readStructureContext(analysis, input, maxSymbols);

			async function analyze(): Promise<AnalyzedFileIndex | undefined> {
				if (Buffer.byteLength(input.content) > invocation.limits.grep_ast_max_file_bytes || /\r(?!\n)/u.test(input.content)) return undefined;
				const file = input.file.workspacePath === undefined ? undefined : bridge.getNativeIdentity(input.file);
				const sourcePath = file === undefined ? input.file.displayPath : path.relative(root.canonicalPath, file.canonicalPath).replaceAll(path.sep, "/");
				const semantic = file === undefined ? undefined : await load().then((lsp) => lsp.documentAnalysis({
					content: input.content, workspaceRoot: root.canonicalPath, filePath: file.canonicalPath,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				})).catch(() => undefined);
				const { analyzeCodeFile } = await import("../../../code-index/parser.ts");
				const syntax = await analyzeCodeFile(sourcePath, input.content, input.signal);
				return mergeCodeStructure(syntax, semantic);
			}
		},
	};
}
