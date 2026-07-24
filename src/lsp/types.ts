import type { CancellationToken } from "vscode-jsonrpc/node";
import type { Diagnostic, DocumentSymbol, ServerCapabilities, SymbolInformation } from "vscode-languageserver-protocol";

/** LSP 诊断严重级别名称，按 protocol 数值从高到低映射。 */
export type LspSeverityName = "error" | "warning" | "information" | "hint";
/** 单个 language server 进程的运行状态。 */
export type LspRuntimeStatus = "idle" | "starting" | "ready" | "unavailable" | "crashed" | "stopped";

/** 通过标准输入输出连接的 LSP server。 */
export interface LspStdioTransport {
	type: "stdio";
	command: string;
	args: string[];
}

/** 连接到已由用户提供的 TCP LSP endpoint。 */
export interface LspTcpTransport {
	type: "tcp";
	host: string;
	port: number;
}

/** LSP server 的规范化连接方式。 */
export type LspTransport = LspStdioTransport | LspTcpTransport;

/** 单个 language server 的规范化配置。 */
export interface LspServerConfig {
	/** LSP server 的稳定 ID；同一 workspace 内用于区分进程。 */
	id: string;
	enabled: boolean;
	transport: LspTransport;
	/** 未命中 extension map 时使用的兼容 language ID。 */
	language_id?: string;
	/** 按规范化扩展名选择 didOpen language ID。 */
	language_ids: Readonly<Record<string, string>>;
	/** 由文件扩展名选择 server，值已规范化为小写并包含前导点。 */
	extensions: string[];
	initialization_options?: Record<string, unknown>;
}

/** 可复用 LSP request 的超时和取消选项。 */
export interface LspRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** initialize 返回的 server capabilities。 */
export type LspServerCapabilities = ServerCapabilities;

/** server 主动 request 的安全边界处理器。 */
export type LspServerRequestHandler = (params: unknown, token: CancellationToken) => unknown | Promise<unknown>;

/** LSP progress notification 的安全原始结构。 */
export interface LspProgressNotification {
	token: string | number;
	value: unknown;
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
	max_open_documents: number;
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

/** diagnostics ledger 中某个 client source+URI 的快照。 */
export interface LspDiagnosticSnapshot {
	source: string;
	uri: string;
	items: LspDiagnosticItem[];
	known: boolean;
	revision: number;
	updatedAt?: number;
	version?: number;
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
