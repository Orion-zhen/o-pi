export type RankingEvidenceFamily = "lexical" | "semantic" | "structural" | "graph";

export type RankingEvidenceSource =
	| "path"
	| "text"
	| "bm25"
	| "ast-symbol"
	| "ast-graph"
	| "lsp-workspace-symbol"
	| "lsp-reference"
	| "repo-map-direct"
	| "repo-map-hop-1"
	| "repo-map-hop-2";

/** RRF 参数集中在这里，benchmark 可以直接导入并校准。rank 从 1 开始。 */
export const RRF_K = 60;
export const RANKING_SOURCE_POLICY: Readonly<Record<RankingEvidenceSource, { family: RankingEvidenceFamily; weight: number }>> = {
	path: { family: "lexical", weight: 1 },
	text: { family: "lexical", weight: 1 },
	bm25: { family: "lexical", weight: 0.9 },
	"ast-symbol": { family: "structural", weight: 1 },
	"ast-graph": { family: "graph", weight: 0.35 },
	"lsp-workspace-symbol": { family: "semantic", weight: 0.95 },
	"lsp-reference": { family: "semantic", weight: 0.5 },
	"repo-map-direct": { family: "structural", weight: 0.85 },
	"repo-map-hop-1": { family: "graph", weight: 0.35 },
	"repo-map-hop-2": { family: "graph", weight: 0.18 },
};

/** 排序热路径使用的固定宽度证据摘要；同 family 只保存最强来源贡献。 */
export interface RankingEvidence {
	readonly mask: number;
	readonly sourceMask: number;
	readonly lexical: number;
	readonly semantic: number;
	readonly structural: number;
	readonly graph: number;
	readonly familyCount: number;
	readonly fusionScore: number;
	readonly bestContribution: number;
}

const LEXICAL_BIT = 1;
const SEMANTIC_BIT = 2;
const STRUCTURAL_BIT = 4;
const GRAPH_BIT = 8;

export const EMPTY_RANKING_EVIDENCE: RankingEvidence = evidenceSummary(0, 0, 0, 0, 0, 0);

const SOURCE_ORDER: readonly RankingEvidenceSource[] = [
	"path",
	"text",
	"bm25",
	"ast-symbol",
	"ast-graph",
	"lsp-workspace-symbol",
	"lsp-reference",
	"repo-map-direct",
	"repo-map-hop-1",
	"repo-map-hop-2",
];

export function rrfContribution(rank: number, weight = 1, confidence = 1): number {
	const safeRank = Math.max(1, Math.floor(rank));
	const safeWeight = Math.max(0, weight);
	const safeConfidence = Math.max(0, Math.min(1, confidence));
	return safeWeight * safeConfidence / (RRF_K + safeRank);
}

export function createSourceRankingEvidence(source: RankingEvidenceSource, rank: number, confidence = 1): RankingEvidence {
	const policy = RANKING_SOURCE_POLICY[source];
	return createRankingEvidence(policy.family, rank, policy.weight, confidence, 1 << SOURCE_ORDER.indexOf(source));
}

export function createRankingEvidence(
	family: RankingEvidenceFamily,
	rank: number,
	weight = 1,
	confidence = 1,
	sourceMask = 0,
): RankingEvidence {
	const contribution = rrfContribution(rank, weight, confidence);
	if (contribution === 0) return EMPTY_RANKING_EVIDENCE;
	if (family === "lexical") return evidenceSummary(LEXICAL_BIT, sourceMask, contribution, 0, 0, 0);
	if (family === "semantic") return evidenceSummary(SEMANTIC_BIT, sourceMask, 0, contribution, 0, 0);
	if (family === "structural") return evidenceSummary(STRUCTURAL_BIT, sourceMask, 0, 0, contribution, 0);
	return evidenceSummary(GRAPH_BIT, sourceMask, 0, 0, 0, contribution);
}

export function mergeRankingEvidence(left: RankingEvidence, right: RankingEvidence): RankingEvidence {
	if (left.mask === 0) return right;
	if (right.mask === 0) return left;
	const mask = left.mask | right.mask;
	const sourceMask = left.sourceMask | right.sourceMask;
	const lexical = Math.max(left.lexical, right.lexical);
	const semantic = Math.max(left.semantic, right.semantic);
	const structural = Math.max(left.structural, right.structural);
	const graph = Math.max(left.graph, right.graph);
	if (mask === left.mask && sourceMask === left.sourceMask && lexical === left.lexical && semantic === left.semantic && structural === left.structural && graph === left.graph) return left;
	if (mask === right.mask && sourceMask === right.sourceMask && lexical === right.lexical && semantic === right.semantic && structural === right.structural && graph === right.graph) return right;
	return evidenceSummary(mask, sourceMask, lexical, semantic, structural, graph);
}

export function rankingEvidenceSources(evidence: RankingEvidence): RankingEvidenceSource[] {
	return SOURCE_ORDER.filter((_source, index) => (evidence.sourceMask & (1 << index)) !== 0);
}

/** tier 相同后只比较 weighted RRF 总和；familyCount 不是独立优先级。 */
export function compareRankingEvidence(left: RankingEvidence, right: RankingEvidence): number {
	return right.fusionScore - left.fusionScore
		|| right.bestContribution - left.bestContribution;
}

function evidenceSummary(mask: number, sourceMask: number, lexical: number, semantic: number, structural: number, graph: number): RankingEvidence {
	const familyCount = Number((mask & LEXICAL_BIT) !== 0)
		+ Number((mask & SEMANTIC_BIT) !== 0)
		+ Number((mask & STRUCTURAL_BIT) !== 0)
		+ Number((mask & GRAPH_BIT) !== 0);
	const fusionScore = lexical + semantic + structural + graph;
	return {
		mask,
		sourceMask,
		lexical,
		semantic,
		structural,
		graph,
		familyCount,
		fusionScore,
		bestContribution: Math.max(lexical, semantic, structural, graph),
	};
}
