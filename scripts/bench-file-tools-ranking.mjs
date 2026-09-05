import { readRuns } from "./benchmark/cli.mjs";
import { createTypeScriptLoader } from "./benchmark/loader.mjs";
import { measureOperation } from "./benchmark/runtime.mjs";
import { row as summaryRow } from "./benchmark/stats.mjs";

const loadTypeScript = createTypeScriptLoader({ moduleCache: true });
const { createFindQueryPlan } = await loadTypeScript("src/file-tools/find/query.ts");
const { createLimitedFindRanker } = await loadTypeScript("src/file-tools/find/ranker.ts");
const {
	rankCodeRegions,
	selectRankedRegions,
} = await loadTypeScript("src/file-tools/grep/ranking.ts");
const { createQueryPlan } = await loadTypeScript("src/file-tools/grep/query-plan.ts");
const runs = readRuns(process.argv.slice(2), { defaultRuns: 15 });
const sizes = [1_000, 5_000, 20_000];
const rows = [];

validateFixedScenarios();

const findPlan = createFindQueryPlan("parser runtime");
if (findPlan.status === "failed") throw new Error(findPlan.error.message);
for (const size of sizes) {
	const candidates = buildFindCandidates(size);
	const ranked = rankFindEntries(candidates, findPlan, candidates.length).ranked;
	const permutedRanked = rankFindEntries(permute(candidates), findPlan, candidates.length).ranked;
	const limited = rankFindEntries(candidates, findPlan, 50);
	if (ranked.length !== candidates.length) throw new Error(`find ranking fixture dropped candidates for N=${size}`);
	if (!samePaths(ranked, permutedRanked)) throw new Error(`find ranking depends on insertion order for N=${size}`);
	if (limited === undefined || limited.totalMatches !== ranked.length || !samePaths(limited.ranked, ranked.slice(0, 50))) {
		throw new Error(`find limited ranking changed the relevance prefix for N=${size}`);
	}
	rows.push(row(`find fzf top-50 N=${size}`, sample(() => rankFindEntries(candidates, findPlan, 50))));
}

const plan = queryPlan("login");
for (const size of sizes) {
	const candidates = buildCandidates(size);
	const ranked = rankCodeRegions(plan, candidates);
	const permuted = permute(candidates);
	const permutedRanked = rankCodeRegions(plan, permuted);
	if (ranked.length !== candidates.length) throw new Error(`ranking fixture dropped candidates for N=${size}`);
	if (!sameIds(ranked, permutedRanked)) throw new Error(`ranking depends on insertion order for N=${size}`);

	rows.push(row(`fixed rank N=${size}`, sample(() => rankCodeRegions(plan, candidates))));
	rows.push(row(`rank + select top-32 N=${size}`, sample(() =>
		selectRankedRegions(rankCodeRegions(plan, permuted), 32))));
}

console.log(`file-tools fixed ranking benchmark (${runs} measured runs, 3 warmups)`);
console.table(rows);

function buildFindCandidates(size) {
	return Array.from({ length: size }, (_value, index) => {
		const searchPath = `packages/component-${index % 128}/parser-runtime-${index}.ts`;
		return {
			path: searchPath,
			searchPath,
			kind: "file",
			scopeOrder: 0,
		};
	});
}

function buildCandidates(size) {
	return Array.from({ length: size }, (_, index) => {
		const profile = index % 5;
		const source = profile === 2 ? "text-regex" : profile >= 3 ? "text-lexical" : undefined;
		const signal = profile === 0
			? "exact_symbol_definition"
			: profile === 1
				? "symbol_prefix"
				: profile === 2
					? "verified_enclosing_region"
					: profile === 3 ? "lexical_high_coverage" : "lexical";
		const role = index % 17 === 0 ? "test" : index % 19 === 0 ? "public_api" : index % 23 === 0 ? "config" : "definition";
		const base = {
			id: `candidate-${index}`,
			path: `${role === "test" ? "tests" : role === "config" ? "config" : "src/group-" + (index % 64)}/file-${index % Math.max(128, Math.floor(size / 8))}.ts`,
			startLine: index * 3 + 1,
			endLine: index * 3 + 1 + index % 24,
			startByte: index * 100,
			endByte: index * 100 + 80,
			kind: "function",
			symbol: signal === "exact_symbol_definition" ? "login" : signal === "symbol_prefix" ? "loginHandler" : `symbol${index % 512}`,
			roles: role === "definition" ? ["definition"] : ["definition", role],
			signals: [signal],
			...(source === undefined ? {} : { evidence: evidence(source, index + 1) }),
			displayLines: [],
		};
		if (source !== "text-regex") return { ...base, queryMatch: "semantic", matchLines: [] };
		const hit = {
			path: base.path,
			line: base.startLine,
			byteStart: base.startByte,
			byteEnd: base.endByte,
			matchStart: 0,
			matchEnd: 5,
			lineText: "login",
		};
		return { ...base, queryMatch: "verified", verifiedHits: [hit], matchLines: [hit.line] };
	});
}

function validateFixedScenarios() {
	for (const [query, expectedFirst] of [
		["login", "exact"],
		["AuthService.login", "qualified"],
		["Error: connection reset by peer", "phrase"],
	]) {
		const candidates = query.includes("AuthService")
			? [region("lexical", "lexical", "text-lexical", 1), region("qualified", "exact_qualified_definition", undefined, 2)]
			: query === "login"
				? [region("lexical", "lexical", "text-lexical", 1), region("exact", "exact_symbol_definition", undefined, 2)]
				: [region("lexical", "lexical_high_coverage", "text-lexical", 1), verifiedRegion("phrase", "verified_enclosing_region", 2)];
		const first = rankCodeRegions(queryPlan(query), candidates)[0]?.id;
		if (first !== expectedFirst) throw new Error(`${query} tier boundary changed: expected ${expectedFirst}, got ${first}`);
	}

	const test = region("test", "exact_symbol_definition", undefined, 1, ["definition", "test"], "tests/login.test.ts");
	const production = verifiedRegion("production", "verified_enclosing_region", 1);
	if (rankCodeRegions(queryPlan("login"), [production, test])[0]?.id !== "test") {
		throw new Error("path context unexpectedly changed ranking");
	}
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
		...(source === undefined ? {} : { evidence: evidence(source, rank) }),
		queryMatch: "semantic",
		matchLines: [],
		displayLines: [],
	};
}

function verifiedRegion(id, signal, rank) {
	const path = `${id}.ts`;
	const hit = {
		path,
		line: rank,
		byteStart: rank * 10,
		byteEnd: rank * 10 + 5,
		matchStart: 0,
		matchEnd: 5,
		lineText: id,
	};
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
		evidence: evidence("text-regex", rank),
		queryMatch: "verified",
		verifiedHits: [hit],
		matchLines: [rank],
	};
}

function evidence(source, rank) {
	return { source, rank };
}

function queryPlan(query) {
	const result = createQueryPlan({ query });
	if (result.status === "failed") throw new Error(result.error.message);
	return result;
}

function permute(values) {
	const result = [];
	for (let index = 0; index < values.length; index += 1) result.push(values[(index * 9_973) % values.length]);
	return result;
}

function sameIds(left, right) {
	return left.length === right.length && left.every((value, index) => value.id === right[index]?.id);
}

function samePaths(left, right) {
	return left.length === right.length
		&& left.every((value, index) => value.entry.path === right[index]?.entry.path);
}

function sample(operation) {
	return measureOperation(operation, { warmups: 3, runs });
}

function rankFindEntries(entries, plan, limit) {
	const ranker = createLimitedFindRanker(plan, limit);
	for (const entry of entries) ranker.add(entry);
	return ranker.result();
}

function row(metric, samples) {
	return summaryRow(metric, samples, 2);
}
