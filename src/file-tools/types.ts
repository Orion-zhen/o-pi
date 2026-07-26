import type { DiagnosticSnapshot, DiagnosticsSummary } from "./shared/diagnostics.js";

export type NewlineKind = "lf" | "crlf" | "mixed" | "none";

export interface TextFile {
	bytes: Buffer;
	text: string;
	version: string;
	sizeBytes: number;
	totalLines: number;
	newline: NewlineKind;
	hasBom: boolean;
}

export type LspDiagnosticsSummary = DiagnosticsSummary;

/** grep 可接收的 LSP symbol 候选；调用方仍需执行 scope、ignore 和预算过滤。 */
export interface FileToolLspSymbolCandidate {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol: string;
	signature?: string;
	reason: "lsp symbol" | "lsp exact symbol" | "lsp reference";
	origin?: "workspace-symbol" | "reference";
}

export type FileToolLspDiagnosticSnapshot = DiagnosticSnapshot;

/** 文件工具可选 LSP hook；实现方必须自行退化，不能改变主工具成功语义。 */
export interface FileToolLspHooks {
	enhanceRead?(input: {
		workspaceRoot: string;
		absolutePath: string;
		relativePath: string;
		content: string;
		start_line: number;
		end_line: number;
		truncated: boolean;
		partial: boolean;
	}): Promise<{
		outline?: Array<{ name: string; kind: string; line: number; end_line: number; detail?: string }>;
		enclosing_symbol?: { name: string; kind: string; line: number; end_line: number; detail?: string };
	} | undefined>;
	grepSymbols?(input: {
		workspaceRoot: string;
		query: string;
		path: string;
		/** 当前 grep 已完成 ignore/glob 过滤的 workspace-relative paths。 */
		allowedPaths: ReadonlySet<string>;
		signal?: AbortSignal;
	}): Promise<FileToolLspSymbolCandidate[]>;
	beforeEdit?(input: {
		workspaceRoot: string;
		path: string;
		absolutePath: string;
	}): Promise<FileToolLspDiagnosticSnapshot | undefined>;
	afterWrite?(input: {
		workspaceRoot: string;
		path: string;
		absolutePath: string;
		content: string;
	}): Promise<LspDiagnosticsSummary | undefined>;
	afterEdit?(input: {
		workspaceRoot: string;
		path: string;
		absolutePath: string;
		content: string;
		baseline?: FileToolLspDiagnosticSnapshot;
	}): Promise<LspDiagnosticsSummary | undefined>;
}

export interface ResolvedPath {
	inputPath: string;
	/** 工具返回路径：相对输入按 cwd 规范化，绝对输入保持绝对。 */
	relativePath: string;
	absolutePath: string;
	realPath: string;
	/** 仅当目标位于 cwd 内时存在，用于匹配 .piignore/.gitignore。 */
	workspacePath?: string;
}
