import type { RepoMapMutationResult, RepoMapReadContext } from "../repo-map/file-tool-query.js";

/** 文件工具返回给模型的稳定错误码。 */
export type FileToolErrorCode =
	| "FILE_NOT_FOUND"
	| "PATH_NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "PROTECTED_PATH"
	| "ACCESS_DENIED"
	| "CONFIG_ERROR"
	| "INVALID_PATH"
	| "INVALID_OPERATION"
	| "READ_REQUIRED"
	| "STALE_READ"
	| "EMPTY_OLD_TEXT"
	| "OLD_TEXT_NOT_FOUND"
	| "OLD_TEXT_NOT_UNIQUE"
	| "OVERLAPPING_REPLACEMENTS"
	| "ENCODING_UNSUPPORTED"
	| "BINARY_FILE_UNSUPPORTED"
	| "OUTPUT_LIMIT_EXCEEDED"
	| "OPERATION_ABORTED"
	| "INVALID_REGEX";

/** 机器可读错误；message 只用于帮助模型和人类理解。 */
export interface FileToolError {
	code: FileToolErrorCode;
	message: string;
	next?: string;
	path?: string;
	edit_index?: number;
	expected?: string;
	actual?: string;
	details?: Record<string, unknown>;
}

export interface FailedResult {
	status: "failed";
	error: FileToolError;
}

export type ToolOutcome<T> = T | FailedResult;

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

export interface ReadParams {
	path: string;
	start_line?: number;
	end_line?: number;
}

export interface WriteParams {
	path: string;
	content: string;
}

export interface LsParams {
	path?: string;
}

/** find 参数：query 自动路由精确路径、glob、名称/路径 fuzzy 与语义召回。 */
export interface FindParams {
	query: string;
	path?: string[];
}

export type GrepMatchMode = "auto" | "literal" | "regex";

export interface GrepParams {
	query: string;
	path?: string;
	match?: GrepMatchMode;
	glob?: string;
}

export interface GrepSkippedFiles {
	binary?: number;
	invalid_utf8?: number;
	access_denied?: number;
	too_large?: number;
}

export interface GrepRegion {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	signature?: string;
	detail: "body" | "snippet" | "signature";
	reasons: string[];
	sources?: string[];
	match_lines?: number[];
	content?: string;
	callees?: string[];
	imports?: string[];
}

export interface GrepNearbyResult {
	path: string;
	start_line: number;
	end_line: number;
	kind: string;
	symbol?: string;
	signature?: string;
	reason: "symbol similarity" | "partial terms" | "path similarity";
}

export interface RepoMapRelatedResult {
	path: string;
	kind: string;
	start_line?: number;
	end_line?: number;
	symbol?: string;
	signature?: string;
	source: "repo-map";
	relations: string[];
	query_match: "not_guaranteed";
}

/** LSP 诊断摘要状态；unavailable/timeout 只表示增强不可用，不影响文件工具主状态。 */
export type LspDiagnosticStatus = "clean" | "warnings" | "errors" | "unavailable" | "timeout";
/** LSP 诊断严重级别，保持与 protocol severity 的语义对应。 */
export type LspDiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** 返回给模型和 TUI 的单条紧凑 LSP 诊断。 */
export interface LspDiagnosticItem {
	severity: LspDiagnosticSeverity;
	line: number;
	column: number;
	message: string;
	code?: string;
	source?: string;
}

/** 写入或编辑后的 LSP 诊断摘要；用于展示 diff，不转成 FailedResult。 */
export interface LspDiagnosticsSummary {
	status: LspDiagnosticStatus;
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

/** read 截断时附加的紧凑 symbol outline。 */
export interface LspOutlineItem {
	name: string;
	kind: string;
	line: number;
	end_line: number;
	detail?: string;
	children?: LspOutlineItem[];
}

/** read 行范围所属的最小包围 symbol。 */
export interface LspEnclosingSymbol {
	name: string;
	kind: string;
	line: number;
	end_line: number;
	detail?: string;
}

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

/** edit 前保存的诊断基线，用于成功写盘后的 diff。 */
export interface FileToolLspDiagnosticSnapshot {
	uri: string;
	items: LspDiagnosticItem[];
	known: boolean;
}

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
	}): Promise<{ outline?: LspOutlineItem[]; enclosing_symbol?: LspEnclosingSymbol } | undefined>;
	grepSymbols?(input: {
		workspaceRoot: string;
		query: string;
		path: string;
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

export interface GrepSuccess {
	status: "success";
	query: string;
	path: string;
	match: GrepMatchMode;
	strategy: string[];
	total_candidates: number;
	returned_regions: number;
	returned_files: number;
	approx_tokens: number;
	scanned_files: number;
	truncated: boolean;
	regions: GrepRegion[];
	related?: RepoMapRelatedResult[];
	skipped_files?: GrepSkippedFiles;
	nearby?: GrepNearbyResult[];
}

export type LsEntryType = "directory" | "file" | "symlink" | "other";

export interface LsEntry {
	name: string;
	path: string;
	type: LsEntryType;
	/** 符号链接的原始目标；只用于 ls 展示，不解析权限或目标类型。 */
	link_target?: string;
	ignored?: boolean;
	ignore_source?: string;
}

export interface LsSuccess {
	path: string;
	entries: LsEntry[];
	truncated: boolean;
	returned_entries?: number;
	total_entries?: number;
	continuation_hint?: string;
}

export interface ReadSuccess {
	path: string;
	content: string;
	start_line: number;
	end_line: number;
	total_lines: number;
	size_bytes: number;
	version: string;
	encoding: "utf-8";
	newline: NewlineKind;
	truncated: boolean;
	continuation?: { start_line: number };
	bom: boolean;
	ignored?: boolean;
	ignore_source?: string;
	lsp?: {
		outline?: LspOutlineItem[];
		enclosing_symbol?: LspEnclosingSymbol;
	};
	repo_map?: RepoMapReadContext;
	skill_resource?: { skill: string; path: string };
}

export interface ReadImageSuccess {
	path: string;
	media_type: "image";
	mime_type: string;
	skill_resource?: { skill: string; path: string };
	content: string;
	size_bytes: number;
	version: string;
	image: {
		data: string;
		mime_type: string;
	};
	hints?: string[];
	ignored?: boolean;
	ignore_source?: string;
}

export type ReadFileSuccess = ReadSuccess | ReadImageSuccess;

export interface WriteSuccess {
	status: "written";
	path: string;
	bytes: number;
	action: "create" | "modify";
	before_version?: string;
	after_version: string;
	before_size_bytes?: number;
	after_size_bytes: number;
	/** Pi TUI 展示用的带行号 diff。 */
	diff: string;
	firstChangedLine?: number;
	lsp?: {
		diagnostics?: LspDiagnosticsSummary;
	};
	repo_map?: RepoMapMutationResult;
}

export type FindEntryKind = "file" | "directory";

/** find 的统一路径条目；tokens 只服务路径相关性评分，不包含文件正文信息。 */
export interface FindEntry {
	path: string;
	kind: FindEntryKind;
	basename: string;
	stem: string;
	extension?: string;
	segments: string[];
	tokens: string[];
	depth: number;
}

export interface FindMatch {
	path: string;
	kind: FindEntryKind;
}

export interface FindNearbyResult extends FindMatch {
	reason: "name similarity";
}

export interface FindCollapsedGroup {
	path: string;
	files: number;
	directories: number;
}

/** find 的内部结构化详情；正文保持 token-efficient，完整统计留给 UI 和测试。 */
export interface FindScopeError {
	path: string;
	error: FileToolError;
}

export interface FindDetails {
	query: string;
	/** 首个有效 scope；保留单路径调用的既有字段。 */
	path: string;
	paths: string[];
	scope_errors?: FindScopeError[];
	strategy: "exact" | "glob" | "fuzzy";
	totalMatches: number;
	returnedMatches: number;
	scannedEntries: number;
	matches: FindMatch[];
	collapsedGroups: FindCollapsedGroup[];
	displayedMatches?: FindMatch[];
	displayedCollapsedGroups?: FindCollapsedGroup[];
	ignoredCount: number;
	skippedCount: number;
	scanTruncated: boolean;
	resultLimited: boolean;
	outputTruncated: boolean;
	related?: RepoMapRelatedResult[];
	nearby?: FindNearbyResult[];
	missingPrefix?: string;
	nearbyDirectory?: string;
	candidateSources?: Record<string, string[]>;
}

/** find 成功结果：content 是模型可见紧凑文本，details 供 UI/内部逻辑使用。 */
export interface FindSuccess {
	content: string;
	details: FindDetails;
}

export interface EditReplacement {
	/** 原文件中唯一且非空的精确匹配文本。 */
	old: string;
	/** 写入到匹配位置的新文本；允许为空字符串以删除该片段。 */
	new: string;
}

export interface EditParams {
	path: string;
	/** 同一文件的一个或多个非重叠替换，全部针对调用开始时的原始内容匹配。 */
	edits: EditReplacement[];
}

export interface EditSuccess {
	status: "applied";
	path: string;
	replacements: number;
	old_version: string;
	new_version: string;
	old_size_bytes: number;
	new_size_bytes: number;
	/** Pi TUI 展示用的带行号 diff。 */
	diff: string;
	/** 第一处变更在新文件中的行号。 */
	firstChangedLine?: number;
	lsp?: {
		diagnostics?: LspDiagnosticsSummary;
	};
	repo_map?: RepoMapMutationResult;
}

export interface EditPreviewSuccess {
	status: "preview";
	path: string;
	replacements: number;
	/** Pi TUI 展示用的带行号 diff。 */
	diff: string;
	/** 第一处变更在新文件中的行号。 */
	firstChangedLine?: number;
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
