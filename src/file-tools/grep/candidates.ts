import type { GrepMatchMode, QueryMatch } from "./types.js";

export type ResultLane = "main" | "nearby" | "related";
export type CandidateRole =
	| "definition"
	| "occurrence"
	| "caller"
	| "callee"
	| "reference"
	| "test"
	| "import"
	| "registration"
	| "public_api"
	| "config"
	| "text";

export type RetrievalSource =
	| "text-literal"
	| "text-regex"
	| "text-lexical"
	| "ast-symbol"
	| "ast-lexical"
	| "ast-relation"
	| "lsp-symbol"
	| "lsp-reference"
	| "repo-map-direct"
	| "repo-map-hop-1"
	| "repo-map-hop-2"
	| "path";

export type CandidateSignal =
	| "exact_qualified_definition"
	| "exact_symbol_definition"
	| "exact_member_definition"
	| "verified_phrase"
	| "verified_text"
	| "verified_qualified_occurrence"
	| "verified_enclosing_region"
	| "verified_text_window"
	| "direct_symbol"
	| "direct_reference"
	| "symbol_prefix"
	| "partial_symbol"
	| "lexical_high_coverage"
	| "lexical"
	| "repo_summary"
	| "multiview_consensus"
	| "requested_relation"
	| "target_definition"
	| "target_occurrence"
	| "indirect_relation"
	| "path";

export interface TextHit {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly mode: Extract<GrepMatchMode, "literal" | "regex">;
	readonly lineText: string;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

export interface LexicalTextAnchor {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineText: string;
	readonly before: readonly string[];
	readonly after: readonly string[];
	readonly matchedTerms: readonly string[];
	readonly phrase: boolean;
	readonly identifier: boolean;
	readonly commentLike: boolean;
	readonly stringLike: boolean;
}

export interface TextFileEvidence {
	readonly path: string;
	readonly matchedTerms: readonly string[];
	readonly pathTerms: readonly string[];
	readonly phraseLines: readonly number[];
	readonly identifierLines: readonly number[];
	readonly anchors: readonly LexicalTextAnchor[];
}

export interface SourceLocalRank {
	readonly source: RetrievalSource;
	readonly rank: number;
	readonly confidence: number;
	readonly hop?: 0 | 1 | 2;
}

interface RetrievalCandidateBase {
	readonly id: string;
	readonly path: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly sourceRank: SourceLocalRank;
	readonly role: CandidateRole;
	readonly signals: readonly CandidateSignal[];
	readonly symbol?: string;
	readonly signature?: string;
}

export type RetrievalCandidate = RetrievalCandidateBase & (
	| { readonly lane: "main"; readonly queryMatch: Exclude<QueryMatch, "not_guaranteed"> }
	| { readonly lane: "nearby" | "related"; readonly queryMatch: "not_guaranteed" }
);

export type ValidatedAnchor = RetrievalCandidate & {
	readonly startLine: number;
	readonly endLine: number;
	readonly metadataVersion: string | number;
	readonly contentHash?: string;
	readonly validatedAt: number;
};

export interface RegionEvidence extends SourceLocalRank {
	readonly reason: string;
}

export interface CodeRegionBase {
	readonly id: string;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly startByte: number;
	readonly endByte: number;
	readonly kind: string;
	readonly symbol?: string;
	readonly qualifiedSymbol?: string;
	readonly signature?: string;
	readonly roles: readonly CandidateRole[];
	readonly signals: readonly CandidateSignal[];
	readonly evidence: readonly RegionEvidence[];
	readonly lane: ResultLane;
}

export interface VerifiedCodeRegion extends CodeRegionBase {
	readonly queryMatch: "verified";
	readonly verifiedHits: readonly [TextHit, ...TextHit[]];
	readonly matchLines: readonly [number, ...number[]];
}

export interface SemanticMainRegion extends CodeRegionBase {
	readonly lane: "main";
	readonly queryMatch: "semantic";
	readonly verifiedHits?: never;
	readonly matchLines: readonly number[];
}

export interface AuxiliaryCodeRegion extends CodeRegionBase {
	readonly lane: "nearby" | "related";
	readonly queryMatch: "not_guaranteed";
	readonly verifiedHits?: never;
	readonly matchLines: readonly number[];
}

export type SemanticCodeRegion = SemanticMainRegion | AuxiliaryCodeRegion;
export type CodeRegion = VerifiedCodeRegion | SemanticCodeRegion;

export interface RankingEvidenceSummary {
	readonly factual: number;
	readonly symbol: number;
	readonly lexical: number;
	readonly semantic: number;
	readonly graph: number;
	readonly familyCount: number;
	readonly fusionScore: number;
	readonly bestContribution: number;
}

export type RankedRegion = CodeRegion & {
	readonly tier: number;
	readonly ranking: RankingEvidenceSummary;
	readonly verifiedCoverage: number;
	readonly requestedRolePriority: number;
};

export type VerifiedRegionInput = Omit<CodeRegionBase, "lane"> & { readonly lane?: "main" };

/** strict/事实主区域只能通过真实 TextHit 构造。 */
export function createVerifiedCodeRegion(
	input: VerifiedRegionInput,
	hits: readonly [TextHit, ...TextHit[]],
): VerifiedCodeRegion {
	for (const hit of hits) {
		if (hit.path !== input.path || hit.line < input.startLine || hit.line > input.endLine) {
			throw new RangeError("verified hit must belong to the region");
		}
	}
	const matchLines = [...new Set(hits.map((hit) => hit.line))].sort((left, right) => left - right);
	const firstLine = matchLines[0];
	if (firstLine === undefined) throw new RangeError("verified region requires a text hit");
	return {
		...input,
		lane: "main",
		queryMatch: "verified",
		verifiedHits: [...hits],
		matchLines: [firstLine, ...matchLines.slice(1)],
	};
}

export function createSemanticCodeRegion(
	input: CodeRegionBase & (
		| { readonly lane: "main"; readonly queryMatch?: "semantic" }
		| { readonly lane: "nearby" | "related"; readonly queryMatch?: "not_guaranteed" }
	),
): SemanticCodeRegion {
	if (input.lane === "main") return { ...input, queryMatch: "semantic", matchLines: [] };
	return { ...input, queryMatch: "not_guaranteed", matchLines: [] };
}
