import { readRuns } from "./benchmark/cli.mjs";
import { createTypeScriptLoader } from "./benchmark/loader.mjs";
import { measureOperation } from "./benchmark/runtime.mjs";
import { row as summaryRow } from "./benchmark/stats.mjs";

const loadTypeScript = createTypeScriptLoader({ moduleCache: true });
const {
	GREP_MMR_LAMBDA,
	GREP_RELEVANCE_HEAD_SIZE,
	GREP_SIMILARITY_WINDOW,
	assignSourceLocalRanks,
	compareRankedRegions,
	rankCodeRegions,
	selectRankedRegions,
	sourceContribution,
	summarizeEvidence,
} = await loadTypeScript("src/file-tools/grep/ranking.ts");
const { createQueryPlan } = await loadTypeScript("src/file-tools/grep/query-plan.ts");
const runs = readRuns(process.argv.slice(2), { defaultRuns: 15 });
const sizes = [1_000, 5_000, 20_000];
const rows = [];

validateFixedScenarios();

const plan = queryPlan("login");
for (const size of sizes) {
	const candidates = buildCandidates(size);
	const ranked = rankCodeRegions(plan, candidates);
	const permuted = permute(candidates);
	const permutedRanked = rankCodeRegions(plan, permuted);
	if (ranked.length !== candidates.length) throw new Error(`ranking fixture dropped candidates for N=${size}`);
	if (!sameIds(ranked, permutedRanked)) throw new Error(`ranking depends on insertion order for N=${size}`);

	const limit = 32;
	const expected = referenceSelection(ranked, limit);
	const selected = selectRankedRegions(permutedRanked, limit);
	if (!sameIds(selected, expected)) throw new Error(`selector changed the bounded reference result for N=${size}`);

	rows.push(row(`adaptive rank N=${size}`, sample(() => rankCodeRegions(plan, candidates))));
	rows.push(row(`tier MMR top-32 N=${size}`, sample(() => selectRankedRegions(ranked, limit))));
	rows.push(row(`rank + select N=${size}`, sample(() => selectRankedRegions(rankCodeRegions(plan, permuted), limit))));
}

console.log(`grep query-adaptive ranking benchmark (${runs} measured runs, 3 warmups; bounded similarity window=${GREP_SIMILARITY_WINDOW})`);
console.table(rows);

function buildCandidates(size) {
	return Array.from({ length: size }, (_, index) => {
		const profile = index % 5;
		const source = profile === 0 ? "ast-symbol" : profile === 1 ? "lsp-symbol" : profile === 2 ? "text-literal" : profile === 3 ? "ast-lexical" : "text-lexical";
		const signal = profile === 0 ? "exact_symbol_definition" : profile === 1 ? "direct_symbol" : profile === 2 ? "verified_text" : profile === 3 ? "lexical_high_coverage" : "lexical";
		const role = index % 17 === 0 ? "test" : index % 19 === 0 ? "public_api" : index % 23 === 0 ? "config" : "definition";
		const base = {
			id: `candidate-${index}`,
			path: `${role === "test" ? "tests" : role === "config" ? "config" : "src/group-" + (index % 64)}/file-${index % Math.max(128, Math.floor(size / 8))}.ts`,
			startLine: index * 3 + 1,
			endLine: index * 3 + 1 + index % 24,
			startByte: index * 100,
			endByte: index * 100 + 80,
			kind: "function",
			symbol: signal === "exact_symbol_definition" ? "login" : `symbol${index % 512}`,
			roles: role === "definition" ? ["definition"] : ["definition", role],
			signals: [signal],
			evidence: [{ source, rank: index + 1, confidence: 1, reason: source }],
		};
		if (source !== "text-literal") return { ...base, queryMatch: "semantic", matchLines: [] };
		const hit = { path: base.path, line: base.startLine, byteStart: base.startByte, byteEnd: base.endByte, mode: "literal", lineText: "login", before: [], after: [] };
		return { ...base, queryMatch: "verified", verifiedHits: [hit], matchLines: [hit.line] };
	});
}

function validateFixedScenarios() {
	for (const [query, expectedFirst] of [
		["login", "exact"],
		["AuthService.login", "qualified"],
		["Error: connection reset by peer", "phrase"],
		["where retry delays are calculated", "phrase"],
		["callers of login", "caller"],
	]) {
		const candidates = query.startsWith("callers")
			? [region("target", "target_definition", "ast-symbol", 1, ["definition"]), region("caller", "requested_relation", "ast-relation", 1, ["caller"])]
			: query.includes("AuthService")
				? [region("lexical", "lexical", "ast-lexical", 1), region("qualified", "exact_qualified_definition", "ast-symbol", 2)]
				: query === "login"
					? [region("lexical", "lexical", "ast-lexical", 1), region("exact", "exact_symbol_definition", "ast-symbol", 2)]
					: [region("lexical", "lexical_high_coverage", "ast-lexical", 1), verifiedRegion("phrase", "verified_phrase", 2)];
		const first = rankCodeRegions(queryPlan(query), candidates)[0]?.id;
		if (first !== expectedFirst) throw new Error(`${query} tier boundary changed: expected ${expectedFirst}, got ${first}`);
	}

	const highRankSingle = summarizeEvidence("natural_language", [evidence("ast-lexical", 1)]);
	const highRankConsensus = summarizeEvidence("natural_language", [evidence("ast-lexical", 2), evidence("ast-symbol", 2)]);
	const lowRankConsensus = summarizeEvidence("natural_language", [evidence("ast-lexical", 200), evidence("ast-symbol", 200)]);
	const duplicateFamily = summarizeEvidence("natural_language", [evidence("ast-lexical", 3), evidence("text-lexical", 1)]);
	if (highRankConsensus.fusionScore <= highRankSingle.fusionScore || lowRankConsensus.fusionScore >= highRankSingle.fusionScore) {
		throw new Error("family-max weighted RRF consensus boundary changed");
	}
	if (Math.abs(duplicateFamily.fusionScore - sourceContribution("natural_language", evidence("ast-lexical", 3))) > 1e-12) {
		throw new Error("same-family evidence was counted more than once");
	}
	if (sourceContribution("relation", { ...evidence("repo-map-hop-1", 1), hop: 1 }) >= sourceContribution("relation", evidence("repo-map-hop-1", 1))) {
		throw new Error("graph hop penalty changed");
	}

	const sourceValues = [
		{ id: "low", source: "ast-symbol", quality: 1 },
		{ id: "text", source: "text-literal", quality: 1 },
		{ id: "high", source: "ast-symbol", quality: 2 },
	];
	const ranks = assignSourceLocalRanks(sourceValues, (value) => value.source, (left, right) => right.quality - left.quality || left.id.localeCompare(right.id));
	if (ranks.get(sourceValues[2]) !== 1 || ranks.get(sourceValues[0]) !== 2 || ranks.get(sourceValues[1]) !== 1) {
		throw new Error("source-local rank generation changed");
	}

	const diverse = Array.from({ length: 20 }, (_, index) => region(
		`role-${index}`,
		"exact_symbol_definition",
		"ast-symbol",
		index + 1,
		index === 4 ? ["definition", "test"] : index === 5 ? ["definition", "public_api"] : index === 6 ? ["definition", "config"] : ["definition"],
		index < 4 ? "src/login.ts" : `src/file-${index}.ts`,
	));
	const selected = selectRankedRegions(rankCodeRegions(queryPlan("login"), diverse), 7);
	if (selected[0]?.id !== "role-5" || selected.some((candidate) => candidate.roles.includes("test"))) {
		throw new Error("context-aware relevance head or role diversity changed");
	}
}

function referenceSelection(candidates, limit) {
	const unique = new Map();
	for (const candidate of candidates) {
		const prior = unique.get(candidate.id);
		if (prior === undefined || compareRankedRegions(candidate, prior) < 0) unique.set(candidate.id, candidate);
	}
	const ranked = [...unique.values()].sort(compareRankedRegions);
	const target = Math.min(limit, ranked.length);
	const headCount = Math.min(GREP_RELEVANCE_HEAD_SIZE, target);
	const selected = ranked.slice(0, headCount);
	const remaining = ranked.slice(headCount);
	const relevance = new Map(ranked.map((candidate, index) => [candidate, 1 - index / Math.max(1, ranked.length - 1)]));
	while (selected.length < target && remaining.length > 0) {
		const tier = remaining[0].tier;
		let tierEnd = 0;
		while (remaining[tierEnd]?.tier === tier) tierEnd += 1;
		const evaluated = Math.min(tierEnd, GREP_SIMILARITY_WINDOW);
		let bestIndex = 0;
		let bestUtility = -Infinity;
		for (let index = 0; index < evaluated; index += 1) {
			const candidateRelevance = relevance.get(remaining[index]) ?? 0;
			const redundancy = Math.max(0, ...selected.map((chosen) => similarity(remaining[index], chosen)));
			const utility = GREP_MMR_LAMBDA * candidateRelevance - (1 - GREP_MMR_LAMBDA) * redundancy;
			if (utility > bestUtility) { bestUtility = utility; bestIndex = index; }
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
	}
	return selected;
}

function similarity(left, right) {
	const samePath = left.path === right.path;
	const leftSymbol = normalizeSymbol(left.qualifiedSymbol ?? left.symbol ?? "");
	const rightSymbol = normalizeSymbol(right.qualifiedSymbol ?? right.symbol ?? "");
	if (samePath && leftSymbol.length > 0 && leftSymbol === rightSymbol) return 1;
	if (samePath && left.startLine <= right.endLine && right.startLine <= left.endLine) return 0.95;
	if (leftSymbol.length > 0 && leftSymbol === rightSymbol) return 0.85;
	const sameRole = primaryRole(left.roles) === primaryRole(right.roles);
	if (samePath && sameRole) return 0.8;
	if (samePath) return 0.65;
	const sameComponent = topComponent(left.path) === topComponent(right.path);
	if (sameRole && sameComponent) return 0.35;
	if (sameRole) return 0.2;
	return sameComponent ? 0.1 : 0;
}

function region(id, signal, source, rank, roles = ["definition"], path = `${id}.ts`) {
	const exactSymbol = signal === "exact_symbol_definition" ? "login" : undefined;
	const exactQualified = signal === "exact_qualified_definition" ? "AuthService.login" : undefined;
	return {
		id,
		path,
		...(exactSymbol === undefined && exactQualified === undefined ? {} : { symbol: exactSymbol ?? "login" }),
		...(exactQualified === undefined ? {} : { qualifiedSymbol: exactQualified }),
		startLine: rank,
		endLine: rank + 2,
		startByte: rank * 10,
		endByte: rank * 10 + 20,
		kind: "function",
		roles,
		signals: [signal],
		evidence: [evidence(source, rank)],
		queryMatch: "semantic",
		matchLines: [],
	};
}

function verifiedRegion(id, signal, rank) {
	const path = `${id}.ts`;
	const hit = { path, line: rank, byteStart: rank * 10, byteEnd: rank * 10 + 5, mode: "literal", lineText: id, before: [], after: [] };
	return {
		id,
		path,
		startLine: rank,
		endLine: rank + 2,
		startByte: rank * 10,
		endByte: rank * 10 + 20,
		kind: "function",
		roles: ["occurrence"],
		signals: [signal],
		evidence: [evidence("text-literal", rank)],
		queryMatch: "verified",
		verifiedHits: [hit],
		matchLines: [rank],
	};
}

function evidence(source, rank) {
	return { source, rank, confidence: 1, reason: source };
}

function queryPlan(query) {
	const result = createQueryPlan({ query });
	if (result.status === "failed") throw new Error(result.error.message);
	return result;
}

function primaryRole(roles) {
	return ["caller", "callee", "reference", "test", "import", "registration", "public_api", "config", "definition", "occurrence", "text"].find((role) => roles.includes(role)) ?? "other";
}

function topComponent(value) {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function normalizeSymbol(value) {
	return value.trim().replace(/::|#/gu, ".").toLocaleLowerCase();
}

function permute(values) {
	const result = [];
	for (let index = 0; index < values.length; index += 1) result.push(values[(index * 9_973) % values.length]);
	return result;
}

function sameIds(left, right) {
	return left.length === right.length && left.every((value, index) => value.id === right[index]?.id);
}

function sample(operation) {
	return measureOperation(operation, { warmups: 3, runs });
}

function row(metric, samples) {
	return summaryRow(metric, samples, 2);
}
