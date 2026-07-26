export interface RepoMapOutputConfig {
	read_context_token_budget: number;
	mutation_impact_token_budget: number;
}

export const DEFAULT_REPO_MAP_OUTPUT_CONFIG: Readonly<RepoMapOutputConfig> = {
	read_context_token_budget: 160,
	mutation_impact_token_budget: 120,
};

/** Token-budget rendering is authoritative; this only bounds candidate collection work. */
export const REPO_MAP_OUTPUT_CANDIDATE_LIMIT = 32;
