import { readRuns } from "./benchmark/cli.mjs";
import { createTypeScriptLoader } from "./benchmark/loader.mjs";
import { measureOperation } from "./benchmark/runtime.mjs";
import { row as summaryRow } from "./benchmark/stats.mjs";

const loadTypeScript = createTypeScriptLoader({ moduleCache: true });
const { compareRankedGrepRegions, fuseRankedGrepSources, mergeRankedGrepSources, selectRankedGrepCandidates } = await loadTypeScript("src/file-tools/grep/fusion.ts");
const { compareRankedFindEntries, fuseRankedFindSources, mergeRankedFindSources, selectRankedFindEntries } = await loadTypeScript("src/file-tools/find/fusion.ts");
const { createFindEntry } = await loadTypeScript("src/file-tools/find/ranker.ts");
const { createSourceRankingEvidence, mergeRankingEvidence } = await loadTypeScript("src/file-tools/shared/ranking/evidence.ts");
const { MMR_LAMBDA, RELEVANCE_HEAD_SIZE, SAME_TIER_SCORE_RATIO_CUTOFF } = await loadTypeScript("src/file-tools/shared/ranking/selection.ts");
const { renderFindResults } = await loadTypeScript("src/file-tools/find/renderer.ts");
const runs = readRuns(process.argv.slice(2), { defaultRuns: 15 });
const sizes = [1_000, 5_000, 20_000];
const rows = [];

validateFixedRelevanceScenarios();

for (const size of sizes) {
	const sources = buildSources(size);
	const merged = mergeRankedGrepSources(...sources);
	const unsorted = permute(merged);
	const limit = 32;
	const expected = referenceHeadMmr(unsorted, limit, compareRankedGrepRegions, (item) => item.tier, (item) => item.evidence.fusionScore, (item) => item.evidence.familyCount >= 2, (item) => item.id, grepSimilarity);
	const selected = selectRankedGrepCandidates(unsorted, limit);
	if (selected.length !== limit || merged.length < size) throw new Error("ranking benchmark fixture is invalid");
	if (selected.some((item, index) => item !== expected[index])) {
		throw new Error("grep selector changed the reference head+MMR result");
	}
	rows.push(row(`fusion + full sort N=${size}`, sample(() => mergeRankedGrepSources(...sources))));
	rows.push(row(`fusion + head+MMR top-32 N=${size}`, sample(() => selectRankedGrepCandidates(fuseGrepSources(sources), limit))));
	rows.push(row(`full sort only N=${merged.length}`, sample(() => [...unsorted].sort(compareRankedGrepRegions))));
	rows.push(row(`head+MMR top-32 N=${merged.length}`, sample(() => selectRankedGrepCandidates(unsorted, limit))));

	const findSources = buildFindSources(size);
	const mergedFind = mergeRankedFindSources(...findSources);
	const unsortedFind = permute(mergedFind);
	const findLimit = 50;
	const expectedFind = referenceHeadMmr(unsortedFind, findLimit, compareRankedFindEntries, (item) => item.tier, (item) => item.evidence.fusionScore, (item) => item.evidence.familyCount >= 2, (item) => item.entry.path, findSimilarity);
	const selectedFind = selectRankedFindEntries(unsortedFind, findLimit);
	if (selectedFind.some((item, index) => item !== expectedFind[index])) throw new Error("bounded find selector changed the diverse top-K result");
	rows.push(row(`find fusion + full sort N=${size}`, sample(() => mergeRankedFindSources(...findSources))));
	rows.push(row(`find fusion + head+MMR top-50 N=${size}`, sample(() => selectRankedFindEntries(fuseFindSources(findSources), findLimit))));
	rows.push(row(`find full sort only N=${mergedFind.length}`, sample(() => [...unsortedFind].sort(compareRankedFindEntries))));
	rows.push(row(`find head+MMR top-50 N=${mergedFind.length}`, sample(() => selectRankedFindEntries(unsortedFind, findLimit))));
}

console.log(`file-tools multi-channel ranking benchmark (${runs} measured runs, 3 warmups; synthetic channels, 50% identity overlap)`);
console.table(rows);

function buildSources(size) {
	const primary = Array.from({ length: size }, (_, index) => region("native", index, index, "lexical", size));
	const channelSize = Math.max(1, Math.floor(size / 3));
	const lsp = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + index;
		return region("lsp", index, identity, "semantic", channelSize);
	});
	const repoMap = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + channelSize + index;
		return region("repo", index, identity, "structural", channelSize);
	});
	return [primary, lsp, repoMap];
}

function fuseGrepSources(sources) {
	const [primary, lsp, repoMap] = sources;
	return fuseRankedGrepSources(primary, lsp, repoMap);
}

function fuseFindSources(sources) {
	const [primary, repoMap] = sources;
	return fuseRankedFindSources(primary, repoMap);
}

function buildFindSources(size) {
	const primary = Array.from({ length: size }, (_, index) => findCandidate(index, index, "lexical", size));
	const channelSize = Math.max(1, Math.floor(size / 3));
	const repoMap = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + index;
		return findCandidate(index, identity, "structural", channelSize);
	});
	return [primary, repoMap];
}

function findCandidate(sourceIndex, identity, family, sourceSize) {
	return {
		entry: createFindEntry(`group-${identity % 64}/feature-${identity}.ts`, "file"),
		tier: identity % 8,
		evidence: createSourceRankingEvidence(findSource(family), sourceIndex + 1),
	};
}

function region(source, sourceIndex, identity, family, sourceSize) {
	const pathIndex = identity % Math.max(64, Math.floor(sourceSize / 4));
	const startLine = identity * 3 + 1;
	return {
		id: `${source}:${identity}`,
		path: `src/group-${pathIndex % 32}/file-${pathIndex}.ts`,
		kind: "function",
		symbol: `symbol${identity}`,
		startLine,
		endLine: startLine + identity % 12,
		startByte: startLine * 10,
		endByte: startLine * 10 + 80,
		tier: identity % 8,
		evidence: createSourceRankingEvidence(grepSource(family), sourceIndex + 1),
		reasons: [source],
		matchLines: [startLine],
		callees: [],
		imports: [],
		lexicalRelevance: 0,
		pathRelevance: 0,
	};
}

function permute(values) {
	const result = [];
	for (let index = 0; index < values.length; index += 1) result.push(values[(index * 9_973) % values.length]);
	return result;
}

function referenceHeadMmr(candidates, limit, compare, tier, score, consensus, identity, similarity) {
	const unique = new Map();
	for (const candidate of candidates) {
		const prior = unique.get(identity(candidate));
		if (prior === undefined || compare(candidate, prior) < 0) unique.set(identity(candidate), candidate);
	}
	const ranked = [...unique.values()].sort(compare);
	const best = new Map();
	for (const candidate of ranked) if (!best.has(tier(candidate))) best.set(tier(candidate), score(candidate));
	const eligible = ranked.filter((candidate) => (best.get(tier(candidate)) ?? 0) <= 0 || score(candidate) >= best.get(tier(candidate)) * SAME_TIER_SCORE_RATIO_CUTOFF || consensus(candidate));
	const target = Math.min(limit, eligible.length);
	const headSize = Math.min(RELEVANCE_HEAD_SIZE, target);
	const selected = eligible.slice(0, headSize);
	const remaining = eligible.slice(headSize);
	const relevance = remaining.map((_candidate, index) => eligible.length <= 1 ? 1 : 1 - (index + headSize) / (eligible.length - 1));
	while (selected.length < target && remaining.length > 0) {
		const currentTier = tier(remaining[0]);
		let bestIndex = -1;
		let utility = -Infinity;
		for (let index = 0; index < remaining.length && tier(remaining[index]) === currentTier; index += 1) {
			const candidateRelevance = relevance[index];
			if (MMR_LAMBDA * candidateRelevance <= utility) break;
			const redundancy = Math.max(0, ...selected.map((chosen) => similarity(remaining[index], chosen)));
			const next = MMR_LAMBDA * candidateRelevance - (1 - MMR_LAMBDA) * redundancy;
			if (next > utility) { utility = next; bestIndex = index; }
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
		relevance.splice(bestIndex, 1);
	}
	return [...selected.slice(0, headSize), ...selected.slice(headSize).sort(compare)];
}

function topDirectory(value) {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function findSource(family) {
	return family === "structural" ? "repo-map-direct" : "path";
}

function grepSource(family) {
	if (family === "semantic") return "lsp-workspace-symbol";
	if (family === "structural") return "ast-symbol";
	return "text";
}

function findSimilarity(left, right) {
	if (left.entry.path === right.entry.path) return 1;
	const sameComponent = topDirectory(left.entry.path) === topDirectory(right.entry.path);
	const sameKind = left.entry.kind === right.entry.kind;
	if (left.entry.basename.toLowerCase() === right.entry.basename.toLowerCase() && sameKind) return 0.8;
	if (sameComponent && sameKind) return 0.22;
	return sameComponent ? 0.1 : 0;
}

function grepSimilarity(left, right) {
	if (left.path === right.path && left.symbol?.toLowerCase() === right.symbol?.toLowerCase()
		&& left.kind.toLowerCase() === right.kind.toLowerCase()) return 1;
	if (left.symbol !== undefined && left.symbol.toLowerCase() === right.symbol?.toLowerCase()) return 0.92;
	const samePath = left.path === right.path;
	const sameRole = role(left) === role(right);
	if (samePath && sameRole) return 0.8;
	if (samePath) return 0.55;
	const sameComponent = topDirectory(left.path) === topDirectory(right.path);
	if (sameComponent && sameRole) return 0.25;
	return sameComponent ? 0.1 : 0;
}

function role(candidate) {
	return candidate.reasons.find((reason) => ["caller", "callee", "reference", "test", "registration"].includes(reason))
		?? (candidate.reasons.some((reason) => reason.includes("symbol") || reason === "definition") ? "definition" : "text");
}

function validateFixedRelevanceScenarios() {
	const dense = Array.from({ length: 5 }, (_, index) => ({
		entry: createFindEntry(`src/auth/high-${index}.ts`, "file"), tier: 2, evidence: createSourceRankingEvidence("path", index + 1),
	}));
	dense.push({ entry: createFindEntry("other/low.ts", "file"), tier: 2, evidence: createSourceRankingEvidence("path", 40) });
	const denseSelected = selectRankedFindEntries(dense, 3);
	if (denseSelected.some((item, index) => item !== dense[index])) throw new Error("relevance head did not preserve dense top-3");

	const consensus = mergeRankingEvidence(createSourceRankingEvidence("text", 2), createSourceRankingEvidence("lsp-workspace-symbol", 2));
	const strongSingle = createSourceRankingEvidence("text", 1);
	const weakConsensus = mergeRankingEvidence(createSourceRankingEvidence("text", 180), createSourceRankingEvidence("lsp-workspace-symbol", 180));
	if (consensus.fusionScore <= strongSingle.fusionScore) throw new Error("high-rank independent consensus was not rewarded");
	if (weakConsensus.fusionScore >= strongSingle.fusionScore) throw new Error("low-rank pseudo-consensus beat a source winner");

	const hop0 = { ...region("repo", 0, 1, "structural", 2), tier: 3, evidence: createSourceRankingEvidence("repo-map-direct", 1) };
	const hop1 = { ...region("repo", 0, 2, "structural", 2), tier: 6, evidence: createSourceRankingEvidence("repo-map-hop-1", 1) };
	if (compareRankedGrepRegions(hop0, hop1) >= 0) throw new Error("graph hop crossed direct tier");

	const roles = [
		{ ...region("ast", 0, 10, "structural", 4), tier: 1, reasons: ["exact qualified symbol"] },
		{ ...region("lsp", 1, 11, "semantic", 4), tier: 6, reasons: ["reference"] },
		{ ...region("repo", 2, 12, "structural", 4), tier: 6, reasons: ["test"] },
		{ ...region("repo", 3, 13, "structural", 4), tier: 5, reasons: ["registration"] },
	];
	if (selectRankedGrepCandidates(roles, 1)[0] !== roles[0]) throw new Error("exact symbol lost mixed-role top-1");

	const rendered = renderFindResults({
		query: "file", path: ".", strategy: "fuzzy", totalMatches: 25, totalFiles: 25, totalDirectories: 0,
		scannedEntries: 25, matches: Array.from({ length: 25 }, (_, index) => ({ path: `${index < 12 ? "z" : "a"}/file-${index}.ts`, kind: "file" })),
		ignoredCount: 0, skippedCount: 0, truncated: false, outputTokenBudget: 2000,
	}).content;
	const top = rendered.split("Other matches:")[0];
	const ordered = Array.from({ length: 12 }, (_, index) => top.indexOf(`z/file-${index}.ts`));
	if (ordered.some((position) => position < 0) || ordered.some((position, index) => index > 0 && position <= ordered[index - 1]) || top.includes("a/file-12.ts")) {
		throw new Error("renderer changed selected relevance order");
	}
}

function sample(operation) {
	return measureOperation(operation, { warmups: 3, runs });
}

function row(metric, samples) {
	return summaryRow(metric, samples, 2);
}
