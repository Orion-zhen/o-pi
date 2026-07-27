export interface RepoMapOutputConfig {
	read_context_token_budget: number;
	mutation_impact_token_budget: number;
}

/** Token-budget rendering is authoritative; this only bounds candidate collection work. */
export const REPO_MAP_OUTPUT_CANDIDATE_LIMIT = 32;
