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
	path: string;
}

/** find 参数：path 是 workspace-relative 搜索根，query 相对该根解释为路径、glob 或名称查询。 */
export interface FindParams {
	query: string;
	path?: string;
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
	match_lines?: number[];
	content?: string;
	callers?: string[];
	callees?: string[];
	imports?: string[];
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
	truncated: boolean;
	regions: GrepRegion[];
	skipped_files?: GrepSkippedFiles;
	near_symbols?: string[];
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
}

export interface WriteSuccess {
	status: "written";
	path: string;
	bytes: number;
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

export interface FindCollapsedGroup {
	path: string;
	files: number;
	directories: number;
}

/** find 的内部结构化详情；正文保持 token-efficient，完整统计留给 UI 和测试。 */
export interface FindDetails {
	query: string;
	path: string;
	strategy: "exact" | "glob" | "fuzzy";
	totalMatches: number;
	returnedMatches: number;
	scannedEntries: number;
	matches: FindMatch[];
	collapsedGroups: FindCollapsedGroup[];
	ignoredCount: number;
	skippedCount: number;
	truncated: boolean;
	suggestions?: FindMatch[];
	missingPrefix?: string;
	nearbyDirectory?: string;
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
	/** Pi TUI 展示用的带行号 diff。 */
	diff: string;
	/** 第一处变更在新文件中的行号。 */
	firstChangedLine?: number;
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
