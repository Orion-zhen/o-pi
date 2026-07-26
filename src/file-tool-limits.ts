export interface FileToolLimits {
	ls_entries: number;
	read_lines: number;
	read_bytes: number;
	read_max_file_bytes: number;
	read_suggestion_limit: number;
	write_max_file_bytes: number;
	edit_max_file_bytes: number;
	edit_match_hint_limit: number;
	find_output_token_budget: number;
	find_result_limit: number;
	find_max_entries_scanned: number;
	grep_output_token_budget: number;
	grep_result_limit: number;
	grep_max_file_bytes: number;
	grep_max_files_scanned: number;
	grep_max_semantic_files: number;
	grep_max_semantic_parse_bytes: number;
}

const DEFAULT_LIMITS: FileToolLimits = {
	ls_entries: 200,
	read_lines: 2_000,
	read_bytes: 50 * 1024,
	read_max_file_bytes: 16 * 1024 * 1024,
	read_suggestion_limit: 3,
	write_max_file_bytes: 16 * 1024 * 1024,
	edit_max_file_bytes: 16 * 1024 * 1024,
	edit_match_hint_limit: 3,
	find_output_token_budget: 800,
	find_result_limit: 50,
	find_max_entries_scanned: 100_000,
	grep_output_token_budget: 1_600,
	grep_result_limit: 8,
	grep_max_file_bytes: 1024 * 1024,
	grep_max_files_scanned: 100_000,
	grep_max_semantic_files: 1_024,
	grep_max_semantic_parse_bytes: 256 * 1024,
};

export function defaultFileToolLimits(): FileToolLimits {
	return structuredClone(DEFAULT_LIMITS);
}
