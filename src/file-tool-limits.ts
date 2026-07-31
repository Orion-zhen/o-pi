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
	find_max_depth: number;
	grep_max_depth: number;
	grep_ast_max_file_bytes: number;
	grep_content_cache_bytes: number;
	grep_content_cache_entries: number;
	grep_result_limit: number;
	grep_related_result_limit: number;
	grep_regional_display_limit: number;
}
