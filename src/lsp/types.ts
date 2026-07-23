import type { Diagnostic, DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";

/** LSP 诊断严重级别名称，按 protocol 数值从高到低映射。 */
export type LspSeverityName = "error" | "warning" | "information" | "hint";
/** 单个 language server 进程的运行状态。 */
export type LspRuntimeStatus = "idle" | "starting" | "ready" | "unavailable" | "crashed" | "stopped";

/** 单个 language server 启动配置。 */
export interface LspServerConfig {
	/** LSP server 的稳定 ID；同一 workspace 内用于区分进程。 */
	id: string;
	enabled: boolean;
	command: string;
	args: string[];
	/** 由文件扩展名选择 server，值必须包含前导点。 */
	extensions: string[];
	initialization_options?: Record<string, unknown>;
}

/** LSP 用户配置；只从用户配置路径读取，不读取项目级配置。 */
export interface LspConfig {
	enabled: boolean;
	/** 精确匹配这些 workspace root 时不启动 LSP。 */
	exclude_paths: string[];
	startup_timeout_ms: number;
	request_timeout_ms: number;
	idle_timeout_ms: number;
	max_restarts: number;
	diagnostics: {
		enabled: boolean;
		max_wait_ms: number;
		settle_ms: number;
		max_items: number;
		min_severity: LspSeverityName;
	};
	read: {
		outline: boolean;
		max_symbols: number;
	};
	grep: {
		workspace_symbols: boolean;
		references: boolean;
		max_symbols: number;
		max_references: number;
	};
	servers: LspServerConfig[];
}

/** 已解析配置及其来源路径。 */
export interface LoadedLspConfig {
	path: string;
	config: LspConfig;
}

/** 紧凑诊断项，用于 file-tools details 和 /lsp diagnostics。 */
export interface LspDiagnosticItem {
	severity: LspSeverityName;
	line: number;
	column: number;
	message: string;
	code?: string;
	source?: string;
}

/** 写入/编辑后返回的诊断摘要。 */
export interface LspDiagnosticsSummary {
	status: "clean" | "warnings" | "errors" | "unavailable" | "timeout";
	file_errors: number;
	file_warnings: number;
	new_errors: number;
	new_warnings: number;
	resolved_errors: number;
	resolved_warnings: number;
	baseline: "known" | "unknown";
	/** 符合 min_severity 的全部诊断数；items 只保留可展示的前 max_items 条。 */
	total_items: number;
	items: LspDiagnosticItem[];
}

/** diagnostics ledger 中某个文件的已知快照。 */
export interface LspDiagnosticSnapshot {
	uri: string;
	items: LspDiagnosticItem[];
	known: boolean;
}

/** read outline 中的紧凑 symbol 条目。 */
export interface LspOutlineItem {
	name: string;
	kind: string;
	line: number;
	end_line: number;
	detail?: string;
	children?: LspOutlineItem[];
}

/** 行范围所属的最小包围 symbol。 */
export interface LspEnclosingSymbol {
	name: string;
	kind: string;
	line: number;
	end_line: number;
	detail?: string;
}

/** workspace/symbol 转换后的 grep 候选。 */
export type LspSymbolOrigin = "workspace-symbol" | "reference";

export interface LspSymbolHit {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol: string;
	signature?: string;
	exact: boolean;
	origin: LspSymbolOrigin;
}

/** /lsp status 展示的单个 server 状态。 */
export interface LspServerStatus {
	id: string;
	root: string;
	status: LspRuntimeStatus;
	last_error?: string;
	restarts: number;
	open_documents: number;
	diagnostics: number;
}

/** /lsp status 展示的全局状态。 */
export interface LspStatus {
	enabled: boolean;
	config_path: string;
	last_error?: string;
	servers: LspServerStatus[];
}

/** 已打开或即将同步给 LSP 的文档上下文。 */
export interface LspClientDocumentContext {
	uri: string;
	path: string;
	text: string;
	languageId: string;
}

/** documentSymbol 返回的两种 protocol 形态。 */
export type LspDocumentSymbols = DocumentSymbol[] | SymbolInformation[];
/** publishDiagnostics 原始诊断类型别名。 */
export type LspRawDiagnostic = Diagnostic;
