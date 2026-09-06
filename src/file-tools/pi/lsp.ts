import path from "node:path";
import type { AnalyzeCode, PrepareCodeAnalysis } from "../../code-index/types.js";
import type { LoadLsp, LspMutationInput } from "../../lsp/file-operations.js";
import type { ReadStructureSource } from "../read/ports.js";
import type { FileToolsInvocation } from "../runtime/host.js";
import type { MutationDiagnosticsSource } from "../shared/mutation-diagnostics.js";
import type { MutationBatchInvocation } from "./mutation-batch.js";
import type { MutationPostProcessObserver } from "./progress.js";

/** 每次调用只绑定一次路径边界。增强失败由命令的可选增强边界处理。 */
export function bindFileLsp(invocation: FileToolsInvocation, load: LoadLsp) {
	const bridge = invocation.nativeBridge;
	const root = bridge.root;
	const structure: ReadStructureSource = {
		async context(input) {
			if (input.file.workspacePath === undefined) return undefined;
			const file = bridge.getNativeIdentity(input.file);
			if (file === undefined) return undefined;
			return (await load()).read({ ...input, workspaceRoot: root.canonicalPath, filePath: file.canonicalPath });
		},
	};
	const prepareCodeAnalysis: PrepareCodeAnalysis = async (input) => {
		if (input.signal?.aborted === true) return;
		const paths = input.paths.filter(isWorkspaceLogicalPath);
		if (paths.length === 0) return;
		await (await load()).prepareCodeAnalysis({ ...input, root: root.nativePath, paths });
	};
	const analyzeCode: AnalyzeCode = async (input) => {
		if (input.signal?.aborted === true || input.targets.some((target) => !isWorkspaceLogicalPath(target.path))) return undefined;
		return (await load()).codeAnalysis({
			...input,
			root: root.nativePath,
			async load(relativePath) {
				const document = await input.load(relativePath);
				if (document === undefined) return undefined;
				const filePath = path.resolve(root.nativePath, relativePath);
				const relative = path.relative(root.nativePath, filePath);
				// Windows 的盘符相对路径也可能跳出根，必须校验解析后的结果。
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
				return { ...document, filePath };
			},
		});
	};
	return { structure, prepareCodeAnalysis, analyzeCode, diagnostics };

	function diagnostics(progress?: MutationPostProcessObserver, batch?: MutationBatchInvocation): MutationDiagnosticsSource {
		return {
			async beforeMutation(input) {
				if (input.target.workspacePath === undefined) return undefined;
				const target = bridge.getNativeIdentity(input.target);
				return target === undefined ? undefined : (await load()).beforeMutation({
					workspaceRoot: root.canonicalPath, filePath: target.canonicalPath,
				});
			},
			async afterMutation(input) {
				if (input.target.workspacePath === undefined) {
					progress?.lspCompleted(undefined);
					return undefined;
				}
				const target = bridge.getNativeIdentity(input.target);
				const lspInput: LspMutationInput | undefined = target === undefined ? undefined : {
					workspaceRoot: root.canonicalPath,
					filePath: target.canonicalPath,
					content: input.content,
					created: input.created,
					...(input.changedRanges === undefined ? {} : {
						changed_ranges: input.changedRanges.map((range) => ({ start_line: range.startLine, end_line: range.endLine })),
					}),
					...(input.baseline === undefined ? {} : { baseline: input.baseline }),
				};
				if (batch !== undefined) return batch.lsp(lspInput, load, progress);
				progress?.lspStarted();
				try {
					const result = lspInput === undefined ? undefined : await (await load()).afterMutation(lspInput);
					progress?.lspCompleted(result);
					return result;
				} catch (error) {
					progress?.lspUnavailable();
					throw error;
				}
			},
		};
	}
}

function isWorkspaceLogicalPath(value: string): boolean {
	if (path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return false;
	return value.replaceAll("\\", "/").split("/").every((segment) => segment !== "..");
}
