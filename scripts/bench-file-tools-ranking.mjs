import { readRuns } from "./benchmark/cli.mjs";
import { createTypeScriptLoader } from "./benchmark/loader.mjs";
import { measureOperation } from "./benchmark/runtime.mjs";
import { row as summaryRow } from "./benchmark/stats.mjs";

const loadTypeScript = createTypeScriptLoader({ moduleCache: true });
const {
	assignSourceLocalRanks,
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

	rows.push(row(`fixed rank N=${size}`, sample(() => rankCodeRegions(plan, candidates))));
	rows.push(row(`rank + select top-32 N=${size}`, sample(() =>
		selectRankedRegions(rankCodeRegions(plan, permuted), 32))));
}

console.log(`grep fixed ranking benchmark (${runs} measured runs, 3 warmups)`);
console.table(rows);

function buildCandidates(size) {
	return Array.from({ length: size }, (_, index) => {
		const profile = index % 5;
		const source = profile === 0 || profile === 1 ? "lsp-symbol" : profile === 2 ? "text-regex" : "text-lexical";
		const signal = profile === 0
			? "exact_symbol_definition"
			: profile === 1
				? "symbol_prefix"
				: profile === 2
					? "verified_text"
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
			evidence: [evidence(source, index + 1)],
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
			? [region("lexical", "lexical", "text-lexical", 1), region("qualified", "exact_qualified_definition", "lsp-symbol", 2)]
			: query === "login"
				? [region("lexical", "lexical", "text-lexical", 1), region("exact", "exact_symbol_definition", "lsp-symbol", 2)]
				: [region("lexical", "lexical_high_coverage", "text-lexical", 1), verifiedRegion("phrase", "verified_phrase", 2)];
		const first = rankCodeRegions(queryPlan(query), candidates)[0]?.id;
		if (first !== expectedFirst) throw new Error(`${query} tier boundary changed: expected ${expectedFirst}, got ${first}`);
	}

	const duplicateFamily = summarizeEvidence([evidence("text-lexical", 3), evidence("text-lexical", 1)]);
	if (Math.abs(duplicateFamily.fusionScore - sourceContribution(evidence("text-lexical", 1))) > 1e-12) {
		throw new Error("same-family evidence was counted more than once");
	}
	const sourceValues = [
		{ id: "low", source: "text-lexical", quality: 1 },
		{ id: "text", source: "text-regex", quality: 1 },
		{ id: "high", source: "text-lexical", quality: 2 },
	];
	const ranks = assignSourceLocalRanks(
		sourceValues,
		(value) => value.source,
		(left, right) => right.quality - left.quality,
		(left, right) => left.id.localeCompare(right.id),
	);
	if (ranks.get(sourceValues[2]) !== 1 || ranks.get(sourceValues[0]) !== 2 || ranks.get(sourceValues[1]) !== 1) {
		throw new Error("source-local rank generation changed");
	}

	const test = region("test", "exact_symbol_definition", "lsp-symbol", 1, ["definition", "test"], "tests/login.test.ts");
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
		evidence: [evidence(source, rank)],
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
		evidence: [evidence("text-regex", rank)],
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
