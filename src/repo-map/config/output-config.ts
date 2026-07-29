export interface RepoMapOutputConfig {
	read_suggestion_limit: number;
	read_test_limit: number;
	mutation_impact_token_budget: number;
}

export const DEFAULT_REPO_MAP_READ_SUGGESTION_LIMIT = 2;
export const DEFAULT_REPO_MAP_READ_TEST_LIMIT = 1;
export const REPO_MAP_READ_CANDIDATE_LIMIT = 32;
