import { compactDisplayLine } from "./display.js";
import type { GrepDisplayLine, GrepMatchedBy, GrepMatchMode, QueryMatch } from "./types.js";

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
	| "verified_text_line"
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
	/** 0-based UTF-16 offsets within lineText. */
	readonly matchStart: number;
	readonly matchEnd: number;
	readonly mode: Extract<GrepMatchMode, "literal" | "regex">;
	readonly lineText: string;
}

export interface LexicalTextAnchor {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineText: string;
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
	readonly declaration?: string;
}

export type RetrievalCandidate = RetrievalCandidateBase & (
	| { readonly lane: "main"; readonly queryMatch: Exclude<QueryMatch, "not_guaranteed"> }
	| { readonly lane: "nearby" | "related"; readonly queryMatch: "not_guaranteed" }
);

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
	readonly declaration?: string;
	/** Internal UTF-8 boundary used only to suppress declaration-duplicate hits. */
	readonly declarationEndByte?: number;
	readonly roles: readonly CandidateRole[];
	readonly signals: readonly CandidateSignal[];
	readonly evidence: readonly RegionEvidence[];
	readonly matchedBy: readonly GrepMatchedBy[];
	readonly displayLines: readonly GrepDisplayLine[];
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
	readonly contextPriority: number;
	readonly rolePriority: number;
};

type DerivedDisplayFields = "lane" | "matchedBy" | "displayLines";
export type VerifiedRegionInput = Omit<CodeRegionBase, DerivedDisplayFields> & { readonly lane?: "main" };
type SemanticRegionBaseInput = Omit<CodeRegionBase, "matchedBy" | "displayLines" | "lane"> & {
	readonly displayLines?: readonly GrepDisplayLine[];
};
type SemanticMainInput = SemanticRegionBaseInput & { readonly lane: "main"; readonly queryMatch?: "semantic" };
type SemanticAuxiliaryInput = SemanticRegionBaseInput & { readonly lane: "nearby" | "related"; readonly queryMatch?: "not_guaranteed" };

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
	const sortedHits = [...hits].sort((left, right) => left.line - right.line || left.byteStart - right.byteStart);
	const matchLines = [...new Set(sortedHits.map((hit) => hit.line))];
	const firstLine = matchLines[0];
	const firstHit = sortedHits[0];
	if (firstLine === undefined || firstHit === undefined) throw new RangeError("verified region requires a text hit");
	const displayLines: GrepDisplayLine[] = [];
	const seenLines = new Set<number>();
	for (const hit of sortedHits) {
		if (seenLines.has(hit.line) || declarationCoversHit(input.declaration, input.declarationEndByte, hit)) continue;
		seenLines.add(hit.line);
		displayLines.push({
			line: hit.line,
			text: compactDisplayLine(hit.lineText, hit.matchStart, hit.matchEnd),
			type: "match",
		});
	}
	return {
		...input,
		lane: "main",
		queryMatch: "verified",
		verifiedHits: [firstHit, ...sortedHits.slice(1)],
		matchLines: [firstLine, ...matchLines.slice(1)],
		matchedBy: normalizeMatchedBy(input.signals, input.evidence),
		displayLines,
	};
}

export function createSemanticCodeRegion(input: SemanticMainInput): SemanticMainRegion;
export function createSemanticCodeRegion(input: SemanticAuxiliaryInput): AuxiliaryCodeRegion;
export function createSemanticCodeRegion(input: SemanticMainInput | SemanticAuxiliaryInput): SemanticCodeRegion {
	const { queryMatch: _queryMatch, ...base } = input;
	if (input.lane === "main") return {
		...base,
		lane: "main",
		queryMatch: "semantic",
		matchedBy: normalizeMatchedBy(input.signals, input.evidence),
		displayLines: input.displayLines ?? [],
		matchLines: [],
	};
	return {
		...base,
		lane: input.lane,
		queryMatch: "not_guaranteed",
		matchedBy: normalizeMatchedBy(input.signals, input.evidence),
		displayLines: input.displayLines ?? [],
		matchLines: [],
	};
}

export function normalizeMatchedBy(
	signals: readonly CandidateSignal[],
	evidence: readonly RegionEvidence[],
): GrepMatchedBy[] {
	const methods = new Set<GrepMatchedBy>();
	const signalSet = new Set(signals);
	const sources = new Set(evidence.map((item) => item.source));
	if (signalSet.has("exact_qualified_definition")) methods.add("exact-qualified-symbol");
	if (signalSet.has("exact_symbol_definition") || signalSet.has("exact_member_definition")) methods.add("exact-symbol");
	if (signalSet.has("symbol_prefix") || signalSet.has("partial_symbol")) methods.add("symbol-prefix");
	if (sources.has("text-literal")) methods.add("literal");
	if (sources.has("text-regex")) methods.add("regex");
	if (sources.has("ast-lexical") || sources.has("text-lexical") || signalSet.has("repo_summary")) methods.add("lexical");
	if (sources.has("ast-relation") || sources.has("lsp-reference") || sources.has("repo-map-hop-1") || sources.has("repo-map-hop-2")
		|| signalSet.has("requested_relation") || signalSet.has("indirect_relation")) methods.add("relationship");
	const order: readonly GrepMatchedBy[] = ["exact-qualified-symbol", "exact-symbol", "symbol-prefix", "literal", "regex", "lexical", "relationship"];
	return order.filter((method) => methods.has(method));
}

function declarationCoversHit(
	declaration: string | undefined,
	declarationEndByte: number | undefined,
	hit: TextHit,
): boolean {
	if (declaration === undefined || declarationEndByte === undefined || hit.byteEnd > declarationEndByte || hit.matchEnd <= hit.matchStart) return false;
	const matched = hit.lineText.slice(hit.matchStart, hit.matchEnd).trim();
	return matched.length > 0 && declaration.includes(matched);
}
