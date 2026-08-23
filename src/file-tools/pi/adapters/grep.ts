import path from "node:path";

import type { FilesystemPathAccess } from "../../../filesystem/contracts/access.js";
import type { CodeAnalysis, CodeAnalysisInput } from "../../../code-index/types.js";
import { GrepTool, formatCompactGrepResult } from "../../grep/command.js";
import type { GrepParams } from "../../grep/types.js";
import type { FileToolsHost, FileToolsInvocation } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { LspFileOperations } from "../../../lsp/index.js";
import { formatErrorModelResult } from "../model-output.js";

export interface ExecuteGrepOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly lsp: LspFileOperations;
	readonly pathAccess: FilesystemPathAccess;
}

export function createGrepAdapter() {
	const tool = new GrepTool();
	return {
		async execute(params: GrepParams, options: ExecuteGrepOptions) {
			const opened = await options.host.open({
				cwd: options.cwd,
				sessionId: options.sessionId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
				pathAccess: options.pathAccess,
			});
			if (isFailed(opened)) return failedResult(opened);
			try {
				const result = await tool.execute(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					limits: opened.limits,
					prepareCodeAnalysis: (input) => prepareCodeAnalysisWithLsp(options.lsp, opened, input),
					analyzeCode: (input) => analyzeCodeWithLsp(options.lsp, opened, input),
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

export async function prepareCodeAnalysisWithLsp(
	lsp: LspFileOperations,
	invocation: FileToolsInvocation,
	input: { readonly paths: readonly string[]; readonly signal?: AbortSignal },
): Promise<void> {
	if (input.signal?.aborted === true || lsp.prepareCodeAnalysis === undefined) return;
	const workspace = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
	if (workspace === undefined) return;
	const paths = input.paths.filter(isWorkspaceLogicalPath);
	if (paths.length === 0) return;
	await lsp.prepareCodeAnalysis({
		root: workspace.nativePath,
		paths,
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}

export async function analyzeCodeWithLsp(
	lsp: LspFileOperations,
	invocation: FileToolsInvocation,
	input: CodeAnalysisInput,
): Promise<CodeAnalysis | undefined> {
	if (input.signal?.aborted === true || lsp.codeAnalysis === undefined
		|| input.targets.some((target) => !isWorkspaceLogicalPath(target.path))) return undefined;
	const workspace = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
	if (workspace === undefined) return undefined;
	return await lsp.codeAnalysis({
		root: workspace.nativePath,
		query: input.query,
		targets: input.targets,
		allowRelated: input.allowRelated,
		limit: input.limit,
		async load(relativePath) {
			const document = await input.load(relativePath);
			if (document === undefined) return undefined;
			const filePath = nativeWorkspacePath(workspace.nativePath, relativePath);
			return filePath === undefined ? undefined : { ...document, filePath };
		},
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}

function isWorkspaceLogicalPath(value: string): boolean {
	if (path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return false;
	const segments = value.replaceAll("\\", "/").split("/");
	return segments.every((segment) => segment !== "..");
}

function nativeWorkspacePath(root: string, relativePath: string): string | undefined {
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		? resolved
		: undefined;
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}
