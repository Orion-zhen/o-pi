import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatEditModelResult, formatWriteModelResult } from "../../src/file-tools/pi/model-output-with-repo.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/file-tool-query.js";
import { analyzeRepoMapImpact } from "../../src/repo-map/impact.js";
import { REPO_IMPACT_TOKEN_BUDGET } from "../../src/repo-map/tool-output.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { activationEntry, configureFileTools, writeSources } from "./fixtures.js";
import { generationWithTestGraph, initializeResult, testGraphSources } from "./test-graph-fixtures.js";

const temp = useTempDir("o-pi-repo-impact-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	await configureFileTools(temp.path, { read_lines: 40, read_bytes: 16_384, find_result_limit: 30, grep_result_limit: 30 });
});

describe("Repo Map change impact", () => {
	it("ranks callers, public API dependents, importers, tests, entrypoints, and bounded component candidates", async () => {
		const before = await generationWithTestGraph(temp.path, testGraphSources("export function loadUser() { return 'user'; }\n"), "1");
		const after = await generationWithTestGraph(temp.path, testGraphSources("export function loadUser(id: string) { return id; }\n"), "2");
		const impact = analyzeRepoMapImpact({ before, after, changedPath: "src/user.ts", maxCandidates: 10 });
		expect(impact.candidate).toBe(true);
		expect(impact.changedSymbols).toContainEqual(expect.stringContaining("loadUser"));
		expect(impact.publicApiChanges).toContainEqual(expect.stringContaining("loadUser"));
		expect(impact.candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/user.ts", impactReason: expect.stringContaining("directly changed"), graphDistance: 0 }),
			expect.objectContaining({ path: "src/caller.ts", role: "caller", impactReason: "direct caller", graphDistance: 1 }),
			expect.objectContaining({ path: "src/caller.ts", role: "public-api", impactReason: "depends on changed public API" }),
			expect.objectContaining({ path: "tests/user.test.ts", role: "test", impactReason: "explicit test relation" }),
		]));
		expect(impact.candidates.every((candidate) => candidate.evidence.length > 0 && candidate.graphDistance <= 2)).toBe(true);
		expect(impact.candidates.length).toBeLessThanOrEqual(10);
		expect(impact.candidates.findIndex((candidate) => candidate.role === "caller"))
			.toBeLessThan(impact.candidates.findIndex((candidate) => candidate.role === "test"));
		const tightlyBounded = analyzeRepoMapImpact({ before, after, changedPath: "src/user.ts", maxCandidates: 3 });
		expect(tightlyBounded.candidates).toHaveLength(3);
		const bodyOnly = await generationWithTestGraph(temp.path, testGraphSources("export function loadUser() { return 'changed body'; }\n"), "4");
		const bodyImpact = analyzeRepoMapImpact({ before, after: bodyOnly, changedPath: "src/user.ts", changedLine: 1 });
		expect(bodyImpact.changedSymbols).toContain("modified function loadUser");
		expect(bodyImpact.publicApiChanges).toEqual([]);
	});

	it("attaches hash-verified compact mutation impact, while inactive or failed analysis stays non-blocking", async () => {
		const beforeSources = testGraphSources("export function loadUser() { return 'user'; }\n");
		const afterSources = testGraphSources("export function loadUser(id: string) { return id; }\n");
		const before = await generationWithTestGraph(temp.path, beforeSources, "1");
		const after = await generationWithTestGraph(temp.path, afterSources, "2");
		await writeSources(temp.path, afterSources);
		const branch = [activationEntry(before.metadata)];
		const refresh = vi.fn(async () => initializeResult(after));
		const readActivated = vi.fn(async (activation: { generation: string }) => activation.generation === before.metadata.generation ? before : after);
		const analyzeImpactSpy = vi.fn(analyzeRepoMapImpact);
		const query = createRepoMapFileToolQuery(() => branch, { readActivated, refresh, analyzeImpact: analyzeImpactSpy });
		const mutation = await query.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts"), changedLine: 1 });
		expect(mutation).toMatchObject({ status: "updated", impact: { candidate: true, changedPath: "src/user.ts" } });
		expect(analyzeImpactSpy).toHaveBeenCalledWith(expect.objectContaining({ changedLine: 1, maxCandidates: 8 }));
		if (mutation === undefined) throw new Error("missing mutation result");
		expect(mutation.impact?.candidates).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "src/caller.ts", role: "caller" }),
			expect.objectContaining({ path: "tests/user.test.ts", role: "test" }),
		]));
		const writeText = formatWriteModelResult({ status: "written", path: "src/user.ts", bytes: 1, diff: "", repo_map: mutation });
		const editText = formatEditModelResult({ status: "applied", path: "src/user.ts", replacements: 1, old_version: "old", new_version: "new", diff: "", repo_map: mutation });
		for (const text of [writeText, editText]) {
			expect(text).toContain('<repo-impact>\nsymbols="api changed function loadUser"');
			expect(text).toContain("\n</repo-impact>");
			expect(text).not.toContain('candidate="true"');
			expect(text).not.toContain('changed="src/user.ts"');
			expect(text).not.toContain('public-api=');
			expect(text).toContain('tests="tests/user.test.ts"');
			expect(text.length).toBeLessThan(1_000);
			const tag = text.match(/<repo-impact>\n[^<]+\n<\/repo-impact>/u)?.[0];
			expect(tag).toBeDefined();
			expect(countTextTokensSync(tag ?? "").tokens).toBeLessThanOrEqual(REPO_IMPACT_TOKEN_BUDGET);
		}

		const analyzeImpact = vi.fn(() => { throw new Error("simulated analysis failure"); });
		const failing = createRepoMapFileToolQuery(() => branch, { readActivated, refresh, analyzeImpact });
		expect(await failing.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts") }))
			.toEqual({ status: "updated", generation: after.metadata.generation });
		const inactiveRefresh = vi.fn(async () => initializeResult(after));
		const inactiveRead = vi.fn(async () => before);
		const inactiveAnalyze = vi.fn(analyzeRepoMapImpact);
		const inactive = createRepoMapFileToolQuery(() => [], { readActivated: inactiveRead, refresh: inactiveRefresh, analyzeImpact: inactiveAnalyze });
		expect(await inactive.syncMutation({ requestedPath: path.join(temp.path, "src/user.ts") })).toBeUndefined();
		expect(inactiveRead).not.toHaveBeenCalled();
		expect(inactiveRefresh).not.toHaveBeenCalled();
		expect(inactiveAnalyze).not.toHaveBeenCalled();
	});
});
