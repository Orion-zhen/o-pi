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
	grep_max_entries_traversed: number;
	grep_max_text_bytes_scanned: number;
	grep_max_text_file_bytes: number;
	grep_max_files_parsed: number;
	grep_max_parse_file_bytes: number;
	grep_output_token_budget: number;
	grep_result_limit: number;
}
