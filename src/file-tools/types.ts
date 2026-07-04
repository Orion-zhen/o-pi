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

/** find 参数：path 是 workspace-relative 搜索根，pattern 是相对该根的 glob。 */
export interface FindParams {
	pattern: string;
	path?: string;
}

export type GrepMode = "content" | "files" | "count";

export interface GrepParams {
	path: string;
	query: string;
	/** grep 默认返回匹配行；files/count 用于先判断分布。 */
	mode?: GrepMode;
	/** 默认字面量搜索，避免调用方为常见标识符手动转义正则。 */
	regex?: boolean;
	/** 仅进一步缩小候选文件范围；ignore 和 workspace 边界仍由工具统一处理。 */
	glob?: string;
	ignore_case?: boolean;
	/** 对称上下文行数，配置和实现共同限制到很小范围。 */
	context?: number;
	/** 最大返回匹配行数；总计数仍尽量精确统计。 */
	limit?: number;
}

export interface GrepLineMatch {
	line: number;
	occurrences: number;
	text: string;
	text_truncated?: boolean;
	context_before?: Array<{ line: number; text: string; text_truncated?: boolean }>;
	context_after?: Array<{ line: number; text: string; text_truncated?: boolean }>;
}

export interface GrepFileMatches {
	path: string;
	total_matching_lines: number;
	total_occurrences: number;
	lines: GrepLineMatch[];
	omitted_lines?: number;
}

export interface GrepSkippedFiles {
	binary?: number;
	invalid_utf8?: number;
	access_denied?: number;
	too_large?: number;
}

export interface GrepSuccess {
	path: string;
	query: string;
	mode: GrepMode;
	total_files: number;
	total_matching_lines: number;
	total_occurrences: number;
	returned_files: number;
	returned_lines: number;
	scan_complete: boolean;
	output_truncated: boolean;
	files?: GrepFileMatches[];
	skipped_files?: GrepSkippedFiles;
	continuation_hint?: string;
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

/** find 的内部结构化详情；不会完整序列化到模型可见正文。 */
export interface FindDetails {
	total: number;
	exactPaths: string[];
	collapsedGroups: Array<{
		path: string;
		count: number;
	}>;
	ignoredCount: number;
	truncated: boolean;
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
