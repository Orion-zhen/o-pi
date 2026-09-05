import { compactDisplayLine } from "./display.js";
import type { CodeAuthority } from "../../code-index/types.js";
import type { GrepDisplayLine, GrepMatchedBy } from "./types.js";

export type SymbolRole = "definition" | "enclosing";

export type RetrievalSource =
	| "text-literal"
	| "text-regex"
	| "text-lexical";

export type CandidateSignal =
	| "exact_qualified_definition"
	| "exact_symbol_definition"
	| "exact_member_definition"
	| "verified_enclosing_region"
	| "verified_text_line"
	| "symbol_prefix"
	| "structured_symbol_match"
	| "structured_path_match"
	| "lexical_high_coverage"
	| "related_symbol"
	| "lexical";

export interface TextHit {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	/** 0-based UTF-16 offsets within lineText. */
	readonly matchStart: number;
	readonly matchEnd: number;
	readonly matchMode: "literal" | "regex";
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
}

export interface TextFileEvidence {
	readonly path: string;
	readonly matchedTerms: readonly string[];
	readonly anchors: readonly LexicalTextAnchor[];
}

export interface RegionEvidence {
	readonly source: RetrievalSource;
	readonly rank: number;
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
	readonly symbolRole?: SymbolRole;
	readonly authority?: CodeAuthority;
	readonly signals: readonly CandidateSignal[];
	readonly evidence?: RegionEvidence;
	readonly displayLines: readonly GrepDisplayLine[];
}

export interface VerifiedCodeRegion extends CodeRegionBase {
	readonly queryMatch: "verified";
	readonly verifiedHits: readonly [TextHit, ...TextHit[]];
	readonly matchLines: readonly [number, ...number[]];
}

export interface SemanticMainRegion extends CodeRegionBase {
	readonly queryMatch: "semantic";
	readonly verifiedHits?: never;
	readonly matchLines: readonly number[];
}

export type CodeRegion = VerifiedCodeRegion | SemanticMainRegion;

export type RankedRegion = CodeRegion & {
	readonly matchedBy: readonly GrepMatchedBy[];
	readonly tier: number;
	readonly fieldScore: number;
	readonly evidenceScore: number;
	readonly verifiedCoverage: number;
};

export type VerifiedRegionInput = Omit<CodeRegionBase, "displayLines">;
type SemanticMainInput = Omit<CodeRegionBase, "displayLines"> & {
	readonly displayLines?: readonly GrepDisplayLine[];
};

/** verified 主区域只能通过真实 TextHit 构造。 */
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
		queryMatch: "verified",
		verifiedHits: [firstHit, ...sortedHits.slice(1)],
		matchLines: [firstLine, ...matchLines.slice(1)],
		displayLines,
	};
}

export function createSemanticCodeRegion(input: SemanticMainInput): SemanticMainRegion {
	return {
		...input,
		queryMatch: "semantic",
		displayLines: input.displayLines ?? [],
		matchLines: [],
	};
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
