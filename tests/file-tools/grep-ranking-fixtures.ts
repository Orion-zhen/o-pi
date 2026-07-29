import { createSemanticCodeRegion, createVerifiedCodeRegion, type CandidateSignal, type CodeRegion, type RankedRegion, type RegionEvidence, type TextHit } from "../../src/file-tools/grep/candidates.js";
import { packGrepResults, type GrepPackInput } from "../../src/file-tools/grep/packer.js";
import { createQueryPlan, type QueryPlan } from "../../src/file-tools/grep/query-plan.js";
import { rankCodeRegions } from "../../src/file-tools/grep/ranking.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import { isFailed } from "../../src/file-tools/shared/result.js";

export function queryPlan(query: string): QueryPlan {
	const result = createQueryPlan({ query });
	if (isFailed(result)) throw new Error(result.error.message);
	return result;
}

export function rankingEvidence(source: RegionEvidence["source"], rank = 1, confidence = 1, hop?: 0 | 1): RegionEvidence {
	return { source, rank, confidence, reason: source, ...(hop === undefined ? {} : { hop }) };
}

export function semanticRegion(input: {
	id: string;
	signals: readonly CandidateSignal[];
	evidence: readonly RegionEvidence[];
	roles?: CodeRegion["roles"];
	path?: string;
	startLine?: number;
	endLine?: number;
	symbol?: string;
	qualifiedSymbol?: string;
}): CodeRegion {
	return createSemanticCodeRegion({
		id: input.id,
		path: input.path ?? `${input.id}.ts`,
		startLine: input.startLine ?? 1,
		endLine: input.endLine ?? 3,
		startByte: 0,
		endByte: 30,
		kind: "function",
		...(input.symbol === undefined ? {} : { symbol: input.symbol }),
		...(input.qualifiedSymbol === undefined ? {} : { qualifiedSymbol: input.qualifiedSymbol }),
		roles: input.roles ?? ["definition"],
		signals: input.signals,
		evidence: input.evidence,
	});
}

export function verifiedRegion(input: { id: string; signals: readonly CandidateSignal[]; evidence: readonly RegionEvidence[] }): CodeRegion {
	const path = `${input.id}.ts`;
	const hit: TextHit = {
		path,
		line: 2,
		byteStart: 10,
		byteEnd: 16,
		matchStart: 0,
		matchEnd: 6,
		lineText: "needle",
	};
	return createVerifiedCodeRegion({
		id: input.id,
		path,
		startLine: 1,
		endLine: 3,
		startByte: 0,
		endByte: 30,
		kind: "function",
		roles: ["occurrence"],
		signals: input.signals,
		evidence: input.evidence,
	}, [hit]);
}

export function packCandidate(input: {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	endByte: number;
	matchLine: number;
	lineText?: string;
	symbol?: string;
	declaration?: string;
	evidence?: readonly RegionEvidence[];
}): RankedRegion {
	const lineText = input.lineText ?? "needle";
	const matchStart = lineText.indexOf("needle");
	const hit: TextHit = {
		path: input.path,
		line: input.matchLine,
		byteStart: 0,
		byteEnd: 1,
		matchStart: Math.max(0, matchStart),
		matchEnd: Math.max(0, matchStart) + 6,
		lineText,
	};
	const region = createVerifiedCodeRegion({
		id: input.id,
		path: input.path,
		startLine: input.startLine,
		endLine: input.endLine,
		startByte: 0,
		endByte: input.endByte,
		kind: "function",
		...(input.symbol === undefined ? {} : { symbol: input.symbol }),
		...(input.declaration === undefined ? {} : { declaration: input.declaration }),
		roles: ["definition"],
		signals: ["verified_enclosing_region"],
		evidence: input.evidence ?? [rankingEvidence("text-regex")],
	}, [hit]);
	const ranked = rankCodeRegions(queryPlan("needle"), [region])[0];
	if (ranked === undefined) throw new Error("pack candidate was not ranked");
	return ranked;
}

export function packRegions(regions: readonly RankedRegion[], overrides: Partial<GrepPackInput> = {}): GrepSuccess {
	return packGrepResults({
		query: "needle",
		path: ".",
		regions,
		stats: {
			traversed_entries: regions.length,
			searched_files: regions.length,
			searched_bytes: regions.length,
			text_hits: regions.reduce((sum, region) => sum + region.matchLines.length, 0),
			parsed_files: 0,
			dropped_text_hits: 0,
			dropped_related_anchors: 0,
			ast_skipped_oversized_files: 0,
		},
		truncationReasons: [],
		resultLimit: 8,
		relatedResultLimit: 8,
		regionalDisplayLimit: 3,
		...overrides,
	});
}
