import { createSemanticCodeRegion, createVerifiedCodeRegion, type CandidateSignal, type CodeRegion, type RankedRegion, type RegionEvidence, type TextHit } from "../../src/file-tools/grep/candidates.js";
import { packGrepResults, type GrepPackInput } from "../../src/file-tools/grep/packer.js";
import { createQueryPlan, type QueryPlan } from "../../src/file-tools/grep/query-plan.js";
import { rankCodeRegions } from "../../src/file-tools/grep/ranking.js";
import type { GrepMatchMode, GrepSuccess } from "../../src/file-tools/grep/types.js";
import { isFailed } from "../../src/file-tools/shared/result.js";

export function queryPlan(query: string, match: GrepMatchMode = "auto"): QueryPlan {
	const result = createQueryPlan({ query, match });
	if (isFailed(result)) throw new Error(result.error.message);
	return result;
}

export function rankingEvidence(source: RegionEvidence["source"], rank = 1, confidence = 1, hop?: 0 | 1 | 2): RegionEvidence {
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
		lane: "main",
	});
}

export function verifiedRegion(input: { id: string; signals: readonly CandidateSignal[]; evidence: readonly RegionEvidence[] }): CodeRegion {
	const path = `${input.id}.ts`;
	const hit: TextHit = {
		path,
		line: 2,
		byteStart: 10,
		byteEnd: 16,
		mode: "literal",
		lineText: "needle",
		before: [],
		after: [],
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
	symbol?: string;
	signature?: string;
	evidence?: readonly RegionEvidence[];
}): RankedRegion {
	const hit: TextHit = {
		path: input.path,
		line: input.matchLine,
		byteStart: 0,
		byteEnd: 1,
		mode: "literal",
		lineText: "needle",
		before: [],
		after: [],
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
		...(input.signature === undefined ? {} : { signature: input.signature }),
		roles: ["definition"],
		signals: ["verified_enclosing_region"],
		evidence: input.evidence ?? [rankingEvidence("text-literal")],
	}, [hit]);
	const ranked = rankCodeRegions(queryPlan("needle", "literal"), [region])[0];
	if (ranked === undefined) throw new Error("pack candidate was not ranked");
	return ranked;
}

export function packRegions(regions: readonly RankedRegion[], overrides: Partial<GrepPackInput> = {}): GrepSuccess {
	return packGrepResults({
		query: "needle",
		path: ".",
		match: "literal",
		totalCandidates: regions.length,
		regions,
		sourceText: new Map(),
		snippets: new Map(),
		stats: { traversed_entries: regions.length, searched_files: regions.length, searched_bytes: regions.length, parsed_files: 0 },
		truncationReasons: [],
		tokenBudget: 400,
		resultLimit: 8,
		nearby: [],
		related: [],
		...overrides,
	});
}
