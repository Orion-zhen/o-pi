import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editFile } from "../../src/file-tools/edit/command.js";
import { formatReadModelResult } from "../../src/file-tools/pi/model-output-with-repo.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { findWorkspaceFiles } from "../helpers/find-tool.js";
import { readWorkspaceFile } from "../helpers/read-tool.js";
import { writeFile as writeFileCommand } from "../../src/file-tools/write/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { computeRepoMapActivation, REPO_MAP_SESSION_ENTRY, type RepoMapActivationEntry } from "../../src/repo-map/runtime/activation.js";
import { createRepoMapFileToolQuery } from "../../src/repo-map/query/file-tool-query.js";
import { RepoMapQueryIndex } from "../../src/repo-map/query/query.js";
import {
	evaluateRepoMapFreshness,
	initializeRepoMap,
	readActivatedRepoMap,
	readActivatedRepoMapState,
	type RefreshActivatedRepoMapInput,
} from "../../src/repo-map/runtime/service.js";
import type { RepoMapGeneration } from "../../src/repo-map/storage/storage.js";
import { formatRepoMapReadContext, READ_REPO_MAP_TOKEN_BUDGET } from "../../src/repo-map/runtime/tool-output.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { createFileToolsExtension } from "../../agent/extensions/file-tools.js";
import { activationEntry, configureFileTools, serviceDependencies as sharedServiceDependencies } from "./fixtures.js";

const temp = useTempDir("o-pi-repo-file-tools-");
const execFileAsync = promisify(execFile);
const gitAvailable = await hasGit();
let fileToolsHost: FileToolsHost;
preserveEnv(
	"PI_REPO_MAP_CACHE_DIR",
	"PI_REPO_MAP_CONFIG",
	"PI_FILE_TOOLS_CONFIG",
	"PI_FILE_TOOLS_PROJECT_CONFIG",
	"PI_FILE_TOOLS_PROJECT_ROOT",
);

beforeEach(async () => {
	await configureFileTools(temp.path, { read_lines: 10, read_bytes: 4096 });
	process.env.PI_REPO_MAP_CACHE_DIR = path.join(temp.path, "cache");
	process.env.PI_REPO_MAP_CONFIG = path.join(temp.path, "repo-map.jsonc");
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
	fileToolsHost = new FileToolsHost();
});

afterEach(() => fileToolsHost.dispose());

describe("Repo Map file-tool read and mutation integration", () => {
	it.skipIf(!gitAvailable)("wires an activated write through the extension and exposes the new symbol to grep", async () => {
		const root = path.join(temp.path, "extension-repo");
		await mkdir(root);
		await execFileAsync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "base.ts"), "export const Base = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root });
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const tools = new Map<string, { execute(...args: unknown[]): Promise<{ content: unknown[]; details?: unknown }> }>();
		const extension = createFileToolsExtension();
		extension({
			registerTool(tool: { name: string }) { tools.set(tool.name, tool as unknown as { execute(...args: unknown[]): Promise<{ content: unknown[]; details?: unknown }> }); },
			appendEntry(_customType: string, data: unknown) { appendEntry(branch, data as RepoMapActivationEntry); },
			on() {},
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: root,
			sessionManager: { getBranch: () => branch, getSessionId: () => "repo-map-file-tools" },
		};
		const write = tools.get("write");
		const grepTool = tools.get("grep");
		if (write === undefined || grepTool === undefined) throw new Error("file tools not registered");
		const written = await write.execute("write-1", { path: "feature.ts", content: "export function ExtensionAdded() { return Base; }\n" }, undefined, undefined, ctx);
		expect(written.details).toMatchObject({ status: "written", repo_map: { status: "updated" } });
		const grep = await grepTool.execute("grep-1", { query: "ExtensionAdded" }, undefined, undefined, ctx);
		expect(grep.details).toMatchObject({ strategy: expect.arrayContaining(["repo-map"]), regions: expect.arrayContaining([
			expect.objectContaining({ symbol: "ExtensionAdded" }),
		]) });
	});

	it("keeps find glob deterministic and enhances strict grep modes against a live generation", async () => {
		const root = path.join(temp.path, "strict-search-repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a-service.ts"), "export function Alpha() { return 'Preferred'; }\n");
		await writeFile(path.join(root, "z-service.ts"), "export function service() { return Preferred(); }\nexport function Preferred() { return true; }\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch = [activationEntry(initialized.metadata)];
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
			},
		});
		const found = await findWorkspaceFiles(root, { query: "*-service.ts" }, undefined, { repoMap: query });
		if ("status" in found) throw new Error(found.error.message);
		expect(found.details.matches.map((match) => match.path)).toEqual(["a-service.ts", "z-service.ts"]);
		expect(found.details.matches.every((match) => /^.+-service\.ts$/u.test(match.path))).toBe(true);

		for (const params of [
			{ query: "Preferred", match: "literal" as const },
			{ query: "Preferred(?:\\(\\))?", match: "regex" as const },
		]) {
			clearGrepIndex();
			const grep = await grepWorkspaceFiles(root, params, undefined, { repoMap: query });
			if (grep.status === "failed") throw new Error(grep.error.message);
			expect(grep.strategy).toContain("repo-map");
			expect(grep.regions.find((region) => region.symbol === "Preferred")?.reasons).toContain(params.match === "literal" ? "definition" : "alias");
			expect(grep.regions.every((region) => (region.match_lines?.length ?? 0) > 0)).toBe(true);
		}
	});

	it("adds compact, budgeted context to partial/truncated reads but leaves a short full read unchanged", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		const longBody = Array.from({ length: 16 }, (_, index) => `  const value${index} = ${index};`).join("\n");
		await writeFile(path.join(root, "a.ts"), `export function Target() {\n${longBody}\n  return value0;\n}\n`);
		await writeFile(path.join(root, "b.ts"), "import { Target } from './a';\nexport function Caller() { return Target(); }\n");
		const deps = serviceDependencies(root);
		const initialized = await initializeRepoMap({ cwd: root }, deps);
		const branch = [activationEntry(initialized.metadata)];
		const createQueryIndex = vi.fn((generation: RepoMapGeneration) => new RepoMapQueryIndex(generation));
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
			},
			createQueryIndex,
		});
		const runtime = {
			repoMap: query,
			formatRepoMapContext: async (context: Parameters<typeof formatRepoMapReadContext>[0]) => formatRepoMapReadContext(context),
		};

		const partial = await readWorkspaceFile(root, { path: "a.ts", start_line: 1, end_line: 4 }, runtime);
		if (!("content" in partial) || "media_type" in partial) throw new Error("partial read failed");
		expect(partial.repo_map).toMatchObject({
			symbol: { name: "Target", qualifiedName: "Target" },
			callers: ["b.ts:Caller"],
			publicApi: true,
		});
		expect(formatReadModelResult(partial)).toContain('<repo_map>\nsymbol="function Target 1-19"');

		const truncated = await readWorkspaceFile(root, { path: "a.ts" }, runtime);
		if (!("content" in truncated) || "media_type" in truncated) throw new Error("truncated read failed");
		expect(truncated.repo_map?.symbol.name).toBe("Target");
		expect(truncated).toMatchObject({ truncated: true, end_line: 7, continuation: { start_line: 8 } });

		const full = await readWorkspaceFile(root, { path: "b.ts" }, runtime);
		expect(full).not.toHaveProperty("repo_map");
		expect(createQueryIndex).toHaveBeenCalledTimes(1);
	});

	it("budgets the rendered read tag exactly and keeps disabled or failed enhancement byte-identical", async () => {
		await configureFileTools(temp.path, { read_lines: 200, read_bytes: 1024 });
		const root = path.join(temp.path, "read-budget");
		await mkdir(root);
		await writeFile(path.join(root, "a.ts"), "123456789\n".repeat(150));
		const params = { path: "a.ts", start_line: 1 } as const;
		const baseline = await readWorkspaceFile(root, params);
		const inactive = await readWorkspaceFile(root, params, { repoMap: { async readContext() { return undefined; } } });
		const failed = await readWorkspaceFile(root, params, { repoMap: { async readContext() { throw new Error("unavailable"); } } });
		expect(inactive).toEqual(baseline);
		expect(failed).toEqual(baseline);

		const enabled = await readWorkspaceFile(root, params, {
			repoMap: {
				async readContext() {
					return {
						symbol: { id: "symbol:Target", kind: "function", name: "Target", startLine: 1, endLine: 150 },
						callers: ["src/caller.ts:Caller"],
						callees: ["src/dependency.ts:load"],
						references: [],
						imports: [],
						publicApi: true,
						relatedTests: ["tests/target.test.ts"],
					};
				},
			},
			formatRepoMapContext: async (context) => formatRepoMapReadContext(context),
		});
		if (!("content" in enabled) || "media_type" in enabled || enabled.repo_map === undefined) throw new Error("enhanced read failed");
		const tag = formatRepoMapReadContext(enabled.repo_map);
		if (tag === undefined) throw new Error("missing rendered Repo Map context");
		const usedBytes = Buffer.byteLength(enabled.content, "utf8") + Buffer.byteLength(`${tag}\n`, "utf8");
		expect(usedBytes).toBeLessThanOrEqual(1024);
		expect(usedBytes + 10).toBeGreaterThan(1024);
		expect(countTextTokensSync(tag).tokens).toBeLessThanOrEqual(READ_REPO_MAP_TOKEN_BUDGET);
		const saturatedTag = formatRepoMapReadContext({
			...enabled.repo_map,
			package: "package-".repeat(40),
			component: "component-".repeat(40),
			callers: Array.from({ length: 8 }, (_, index) => `src/${"caller".repeat(20)}-${index}.ts:Caller`),
			callees: Array.from({ length: 8 }, (_, index) => `src/${"callee".repeat(20)}-${index}.ts:callee`),
			references: Array.from({ length: 8 }, (_, index) => `src/${"reference".repeat(20)}-${index}.ts:reference`),
			imports: Array.from({ length: 8 }, (_, index) => `src/${"import".repeat(20)}-${index}.ts`),
		});
		expect(saturatedTag).toContain('symbol="function Target 1-150"');
		expect(countTextTokensSync(saturatedTag ?? "").tokens).toBeLessThanOrEqual(READ_REPO_MAP_TOKEN_BUDGET);
		const expandableContext = {
			...enabled.repo_map,
			callers: Array.from({ length: 12 }, (_, index) => `src/caller-${index}.ts:Caller${index}`),
			callees: Array.from({ length: 12 }, (_, index) => `src/callee-${index}.ts:callee${index}`),
			references: [],
			imports: [],
		};
		const defaultTag = formatRepoMapReadContext(expandableContext, {
			read_context_token_budget: 160,
			mutation_impact_token_budget: 120,
		});
		const expandedTag = formatRepoMapReadContext(expandableContext, {
			read_context_token_budget: 640,
			mutation_impact_token_budget: 120,
		});
		expect(defaultTag).not.toContain("callee-11");
		expect(expandedTag).toContain("caller-11");
		expect(expandedTag).toContain("callee-11");
		expect(countTextTokensSync(expandedTag ?? "").tokens).toBeLessThanOrEqual(640);
		expect(countTextTokensSync(expandedTag ?? "").tokens).toBeGreaterThan(countTextTokensSync(defaultTag ?? "").tokens);
		expect(formatRepoMapReadContext(expandableContext, {
			read_context_token_budget: 0,
			mutation_impact_token_budget: 120,
		})).toBeUndefined();

		const duplicateLspResult = {
			...enabled,
			lsp: { enclosing_symbol: { name: "Target", kind: "function", line: 1, end_line: 150 } },
		};
		const withDuplicateLsp = formatReadModelResult(duplicateLspResult);
		expect(withDuplicateLsp).toContain("<repo_map>\n");
		expect(withDuplicateLsp).toContain("\n</repo_map>");
		expect(withDuplicateLsp).not.toContain("<lsp ");
	});

	it("skips refresh for mutations outside scan scope but keeps unignored untracked files refreshable", async () => {
		await writeFile(path.join(temp.path, "file-tools.jsonc"), JSON.stringify({
			blocked_path: [".git/"],
			ignored_path: ["scratch/"],
			ignore: { builtin_profile: "none", gitignore: true },
		}));
		const root = path.join(temp.path, "mutation-scope-repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await mkdir(path.join(root, "agent", "sessions"), { recursive: true });
		await mkdir(path.join(root, "scratch"), { recursive: true });
		await writeFile(path.join(root, ".gitignore"), "agent/sessions\n");
		await writeFile(path.join(root, "base.ts"), "export const Base = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const generation = await readActivatedRepoMap({
			root,
			mapId: initialized.metadata.mapId,
			generation: initialized.metadata.generation,
		}, path.join(temp.path, "cache"));
		expect(generation?.files.map((file) => file.path)).not.toContain("agent/sessions/session.jsonl");
		const branch = [activationEntry(initialized.metadata)];
		const refresh = vi.fn(async () => initialized);
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
			},
			refresh,
		});

		for (const excludedPath of ["agent/sessions/session.jsonl", "scratch/runtime.log", ".git/runtime-state"]) {
			await writeFile(path.join(root, excludedPath), "runtime data\n");
			expect(await query.syncMutation({ requestedPath: path.join(root, excludedPath) })).toBeUndefined();
		}
		expect(refresh).not.toHaveBeenCalled();

		await writeFile(path.join(root, "untracked.ts"), "export const Untracked = true;\n");
		expect(await query.syncMutation({ requestedPath: path.join(root, "untracked.ts") })).toMatchObject({ status: "updated" });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("refreshes after write/edit, switches activation, and removes obsolete symbols and edges", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "base.ts"), "export const Base = 1;\n");
		const deps = serviceDependencies(root);
		const initialized = await initializeRepoMap({ cwd: root }, deps);
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const appendActivation = (entry: RepoMapActivationEntry): void => appendEntry(branch, entry);
		const createQueryIndex = vi.fn((generation: RepoMapGeneration) => new RepoMapQueryIndex(generation));
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
			},
			async refresh(input) {
				return await initializeRepoMap({ cwd: input.activation.root, mode: "refresh", ...(input.signal !== undefined ? { signal: input.signal } : {}) }, deps);
			},
			appendActivation,
			now: () => new Date("2026-07-17T01:00:00.000Z"),
			createQueryIndex,
		});

		const written = await writeWorkspaceFile(root, {
			path: "feature.ts",
			content: "export function Added() { return Base; }\n",
		});
		if (written.status !== "written") throw new Error(written.error.message);
		const writeUpdate = await query.syncMutation({ requestedPath: path.join(root, "feature.ts") });
		if (writeUpdate !== undefined) written.repo_map = writeUpdate;
		expect(written.repo_map).toMatchObject({ status: "updated" });
		const afterWrite = computeRepoMapActivation(branch);
		expect(afterWrite?.generation).not.toBe(initialized.metadata.generation);
		let generation = await activatedGeneration(branch);
		expect(generation.symbols.map((symbol) => symbol.name)).toContain("Added");
		clearGrepIndex();
		const grep = await grepWorkspaceFiles(root, { query: "Added" }, undefined, { repoMap: query });
		if (grep.status === "failed") throw new Error(grep.error.message);
		expect(grep.strategy).toContain("repo-map");
		expect(grep.regions.some((region) => region.symbol === "Added")).toBe(true);

		await readWorkspaceFile(root, { path: "feature.ts" }, { host: fileToolsHost, sessionId: "repo-mutation" });
		const edited = await editWorkspaceFile(root, {
			path: "feature.ts",
			edits: [{ old: "Added", new: "Replacement" }],
		});
		if (edited.status !== "applied") throw new Error(edited.error.message);
		const editUpdate = await query.syncMutation({ requestedPath: path.join(root, "feature.ts") });
		if (editUpdate !== undefined) edited.repo_map = editUpdate;
		expect(edited.repo_map).toMatchObject({ status: "updated" });
		generation = await activatedGeneration(branch);
		expect(generation.symbols.map((symbol) => symbol.name)).toContain("Replacement");
		expect(generation.symbols.map((symbol) => symbol.name)).not.toContain("Added");
		const replacement = await query.query({ requestedPath: root, query: "Replacement", limit: 5 });
		expect(replacement?.candidates.some((candidate) => candidate.symbol?.name === "Replacement")).toBe(true);
		expect(createQueryIndex).toHaveBeenCalledTimes(2);
		const nodeIds = new Set([
			`repository:${generation.metadata.mapId}`,
			...generation.files.map((file) => file.id),
			...generation.symbols.map((symbol) => symbol.id),
			...generation.architecture.map((node) => node.id),
		]);
		expect(generation.edges.every((edge) => nodeIds.has(edge.from) && (nodeIds.has(edge.to) || edge.to.startsWith("external:") || edge.to.startsWith("lexical:symbol:")))).toBe(true);
	});

	it("automatically refreshes a stale map once for concurrent file-tool queries", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const refreshedMetadata = { ...initialized.metadata, generation: "f".repeat(64), freshness: "fresh" as const };
		const generation = (metadata: typeof initialized.metadata): RepoMapGeneration => ({
			metadata,
			files: [],
			symbols: [],
			tests: [],
			architecture: [],
			aliases: [],
			edges: [],
			diagnostics: [],
		});
		const refresh = vi.fn(async () => ({ ...initialized, metadata: refreshedMetadata }));
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return generation(activation.generation === refreshedMetadata.generation
					? refreshedMetadata
					: { ...initialized.metadata, freshness: "stale" });
			},
			refresh,
			appendActivation(entry) { appendEntry(branch, entry); },
		});

		const results = await Promise.all([
			query.query({ requestedPath: root, query: "A", limit: 5 }),
			query.query({ requestedPath: root, query: "A", limit: 5 }),
		]);
		expect(results.every((result) => result !== undefined)).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(computeRepoMapActivation(branch)?.generation).toBe(refreshedMetadata.generation);
	});

	it("stops waiting for Repo Map reads when a file-tool query is cancelled", async () => {
		const root = path.join(temp.path, "cancelled-query-repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const pending = deferred<RepoMapGeneration | undefined>();
		const readActivated = vi.fn(async () => await pending.promise);
		const query = createRepoMapFileToolQuery(() => branch, { readActivated });
		const controller = new AbortController();

		const result = query.query({ requestedPath: root, query: "A", limit: 5, signal: controller.signal });
		expect(readActivated).toHaveBeenCalledTimes(1);
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		pending.resolve(undefined);
	});

	it("cancels an automatic stale refresh when its last file-tool consumer is cancelled", async () => {
		const root = path.join(temp.path, "cancelled-refresh-repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const started = deferred<void>();
		let refreshSignal: AbortSignal | undefined;
		const refresh = vi.fn(async (input: RefreshActivatedRepoMapInput) => {
			if (input.signal === undefined) throw new Error("refresh signal missing");
			refreshSignal = input.signal;
			started.resolve(undefined);
			await new Promise<void>((_resolve, reject) => {
				input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			});
			return initialized;
		});
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated() {
				return {
					metadata: { ...initialized.metadata, freshness: "stale" },
					files: [], symbols: [], tests: [], architecture: [], aliases: [], edges: [], diagnostics: [],
				};
			},
			refresh,
		});
		const controller = new AbortController();
		const result = query.query({ requestedPath: root, query: "A", limit: 5, signal: controller.signal });
		await started.promise;
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		expect(refreshSignal?.aborted).toBe(true);
	});

	it("keeps a successful write successful when map update fails and marks the activation partially stale", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const query = createRepoMapFileToolQuery(() => branch, {
			async refresh() { throw new Error("cache unavailable"); },
			appendActivation(entry) { appendEntry(branch, entry); },
			now: () => new Date("2026-07-17T02:00:00.000Z"),
		});
		const written = await writeWorkspaceFile(root, { path: "a.ts", content: "export const A = 2;\n" });
		expect(written).toMatchObject({ status: "written" });
		const update = await query.syncMutation({ requestedPath: path.join(root, "a.ts") });
		expect(update).toMatchObject({ status: "partially_stale", diagnostic: "cache unavailable" });
		expect(computeRepoMapActivation(branch)).toMatchObject({ freshness: "partially_stale", diagnostic: "cache unavailable" });
		expect(await readFile(path.join(root, "a.ts"), "utf8")).toContain("A = 2");
	});

	it("marks a live hash mismatch partially stale and excludes the unverified node", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const Before = 1;\n");
		const initialized = await initializeRepoMap({ cwd: root }, serviceDependencies(root));
		const branch: SessionEntry[] = [activationEntry(initialized.metadata)];
		const query = createRepoMapFileToolQuery(() => branch, {
			async readActivated(activation) {
				return await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
			},
			appendActivation(entry) { appendEntry(branch, entry); },
		});
		await writeFile(path.join(root, "a.ts"), "export const After = 2;\n");
		const result = await query.query({ requestedPath: root, query: "Before", limit: 5 });
		expect(result?.candidates).toEqual([]);
		expect(computeRepoMapActivation(branch)?.freshness).toBe("partially_stale");
	});
});

describe("Repo Map freshness and rebuild modes", () => {
	it("classifies HEAD/config/ignore changes as stale while preserving partial state otherwise", () => {
		const metadata = {
			freshness: "fresh" as const,
			gitRevision: "a".repeat(40),
			configFingerprint: "b".repeat(64),
			ignoreFingerprint: "ignore-a",
		};
		const current = {
			gitRevision: metadata.gitRevision,
			configFingerprint: metadata.configFingerprint,
			ignoreFingerprint: metadata.ignoreFingerprint,
		};
		expect(evaluateRepoMapFreshness(metadata, current)).toBe("fresh");
		expect(evaluateRepoMapFreshness(metadata, current, "partially_stale")).toBe("partially_stale");
		for (const changed of [
			{ ...current, gitRevision: "c".repeat(40) },
			{ ...current, configFingerprint: "d".repeat(64) },
			{ ...current, ignoreFingerprint: "ignore-b" },
		]) expect(evaluateRepoMapFreshness(metadata, changed, "partially_stale")).toBe("stale");
	});

	it("refresh reuses unchanged generations, rebuild reparses all files, and cancellation preserves CURRENT", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export function A() {}\n");
		const deps = serviceDependencies(root);
		const first = await initializeRepoMap({ cwd: root }, deps);
		const refreshed = await initializeRepoMap({ cwd: root, mode: "refresh" }, deps);
		expect(refreshed).toMatchObject({ reusedGeneration: true, summary: { reused: 1, reusedParsed: 1, hashed: 0 } });
		const rebuilt = await initializeRepoMap({ cwd: root, mode: "rebuild" }, deps);
		expect(rebuilt).toMatchObject({ summary: { reused: 0, reusedParsed: 0, hashed: 1 } });
		const currentPath = path.join(temp.path, "cache", first.metadata.mapId, "CURRENT");
		const before = await readFile(currentPath, "utf8");
		const controller = new AbortController();
		controller.abort();
		await expect(initializeRepoMap({ cwd: root, mode: "refresh", signal: controller.signal }, deps)).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
		expect(await readFile(currentPath, "utf8")).toBe(before);
		await expect(initializeRepoMap({ cwd: root, mode: "rebuild" }, {
			...deps,
			async scan() { throw new Error("scan failed"); },
		})).rejects.toThrow("scan failed");
		expect(await readFile(currentPath, "utf8")).toBe(before);
	});

	it.skipIf(!gitAvailable)("detects live HEAD/config/ignore changes and corrupt CURRENT as unavailable", async () => {
		const root = path.join(temp.path, "git-repo");
		await mkdir(root);
		await execFileAsync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "a.ts"), "export const A = 1;\n");
		await execFileAsync("git", ["-C", root, "add", "a.ts"]);
		await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"]);
		const first = await initializeRepoMap({ cwd: root });
		let activation = activationFromMetadata(first.metadata);
		expect((await readActivatedRepoMapState(activation))?.metadata.freshness).toBe("fresh");

		await writeFile(process.env.PI_REPO_MAP_CONFIG ?? "", JSON.stringify({ scan: { concurrency: 2 } }));
		expect((await readActivatedRepoMapState(activation))?.metadata.freshness).toBe("stale");
		const configRefresh = await initializeRepoMap({ cwd: root, mode: "refresh" });
		activation = activationFromMetadata(configRefresh.metadata);
		await writeFile(path.join(root, ".piignore"), "ignored.ts\n");
		expect((await readActivatedRepoMapState(activation))?.metadata.freshness).toBe("stale");
		const ignoreRefresh = await initializeRepoMap({ cwd: root, mode: "refresh" });
		activation = activationFromMetadata(ignoreRefresh.metadata);
		await writeFile(path.join(root, "head.txt"), "head\n");
		await execFileAsync("git", ["-C", root, "add", "head.txt"]);
		await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "head"]);
		expect((await readActivatedRepoMapState(activation))?.metadata.freshness).toBe("stale");
		const currentPath = path.join(temp.path, "cache", activation.mapId, "CURRENT");
		await writeFile(currentPath, "corrupt\n");
		expect(await readActivatedRepoMapState(activation)).toBeUndefined();
	});
});

function serviceDependencies(root: string) {
	return sharedServiceDependencies(root, path.join(temp.path, "cache"), new Date("2026-07-17T00:00:00.000Z"));
}

function activationFromMetadata(metadata: { repositoryRoot: string; mapId: string; generation: string; updatedAt: string }): RepoMapActivationEntry {
	return {
		kind: "activation",
		root: metadata.repositoryRoot,
		mapId: metadata.mapId,
		generation: metadata.generation,
		activatedAt: metadata.updatedAt,
	};
}

function appendEntry(branch: SessionEntry[], data: RepoMapActivationEntry): void {
	branch.push({
		type: "custom",
		id: `entry-${branch.length}`,
		parentId: null,
		timestamp: data.activatedAt,
		customType: REPO_MAP_SESSION_ENTRY,
		data,
	});
}

async function activatedGeneration(branch: SessionEntry[]): Promise<RepoMapGeneration> {
	const activation = computeRepoMapActivation(branch);
	if (activation === undefined) throw new Error("missing activation");
	const generation = await readActivatedRepoMap(activation, path.join(temp.path, "cache"));
	if (generation === undefined) throw new Error("missing generation");
	return generation;
}

async function writeWorkspaceFile(cwd: string, params: { path: string; content: string }) {
	const opened = await fileToolsHost.open({ cwd, sessionId: "repo-mutation" });
	if ("status" in opened) return opened;
	try {
		return await writeFileCommand(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			maxFileBytes: opened.limits.write_max_file_bytes,
			diff: piTextDiffGenerator,
		});
	} finally {
		opened.dispose();
	}
}

async function editWorkspaceFile(cwd: string, params: { path: string; edits: Array<{ old: string; new: string }> }) {
	const opened = await fileToolsHost.open({ cwd, sessionId: "repo-mutation" });
	if ("status" in opened) return opened;
	try {
		return await editFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			observation: opened.observation,
			maxFileBytes: opened.limits.edit_max_file_bytes,
			matchHintLimit: opened.limits.edit_match_hint_limit,
			diff: piTextDiffGenerator,
		});
	} finally {
		opened.dispose();
	}
}

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let settle: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => { settle = resolve; });
	return {
		promise,
		resolve(value) {
			if (settle === undefined) throw new Error("Deferred promise was not initialized");
			settle(value);
		},
	};
}
