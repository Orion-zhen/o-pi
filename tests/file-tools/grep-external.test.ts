import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseCodeUnits } from "../../src/code-index/parser.js";
import { packGrepResults } from "../../src/file-tools/grep/packer.js";
import { formatCompactGrepResult, GrepTool } from "../../src/file-tools/grep/command.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import type { GrepExternalCandidate, GrepGraphSource, GrepSymbolSource } from "../../src/file-tools/grep/ports.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import type { RepoMapQueryCandidate, RepoMapQueryResult } from "../../src/repo-map/query/query.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { createGrepTestContext, expectGrepSuccess, firstRegion, assertStrictMatches, deferredVoid, grepWithSources, repoMapCandidate, repoMapQuery, writeConfig } from "./grep-fixtures.js";
import { packCandidate, rankingEvidence } from "./grep-ranking-fixtures.js";

const testContext = createGrepTestContext();

describe("grep external", () => {
	it.each([
		{ match: "literal" as const, queryText: "Needle42", source: "text-literal" },
		{ match: "regex" as const, queryText: "Needle\\d+", source: "text-regex" },
	])("$match 严格事实链可查询 Repo Map，但主结果仍全部来自 line scan", async ({ match, queryText, source }) => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export const first = 'Needle42';\n");
		await writeFile(path.join(testContext.workspace, "z.ts"), "export const second = 'Needle42';\n");
		const query = vi.fn(async (): Promise<RepoMapQueryResult | undefined> => undefined);
		const result = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: queryText, match },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledOnce();
		expect(result.regions.map((region) => region.path)).toEqual(["a.ts", "z.ts"]);
		expect(result.regions.every((region) => region.sources.includes(source) && region.query_match === "verified")).toBe(true);
		expect(result.related).toBeUndefined();
		await assertStrictMatches(testContext.workspace, result, queryText, match);
	});

	it("严格主结果为空时外部通道仍可独立安全降级", async () => {
		await writeFile(path.join(testContext.workspace, "related.ts"), "export function RelatedDefinition() { return 'other'; }\n");
		const query = vi.fn(async (): Promise<RepoMapQueryResult | undefined> => undefined);
		const result = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: "MissingNeedle", match: "literal" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledOnce();
		expect(result.regions).toEqual([]);
		expect(result.related).toBeUndefined();
		expect(formatCompactGrepResult(result)).toContain("none");
	});

	it("strict basename glob 排除 scope/glob 外 Repo Map 候选", async () => {
		await mkdir(path.join(testContext.workspace, "src", "deep"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "tests"));
		await writeFile(path.join(testContext.workspace, "src", "deep", "match.ts"), "export const match = 'Needle42';\n");
		const relatedText = "export function RelatedTest() { return 'Needle42'; }\n";
		await writeFile(path.join(testContext.workspace, "tests", "related.test.ts"), relatedText);
		const relatedUnit = (await parseCodeUnits("tests/related.test.ts", relatedText)).units.find((item) => item.name === "RelatedTest");
		if (relatedUnit === undefined) throw new Error("missing parsed fixture unit");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: testContext.workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("tests/related.test.ts", relatedText, relatedUnit, ["definition"])],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: "Needle42", match: "literal", glob: "match*.ts" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions.map((region) => region.path)).toEqual(["src/deep/match.ts"]);
		expect(query).toHaveBeenCalledOnce();
		expect(result.related).toBeUndefined();
	});

	it("strict 主结果充足时外部候选保持 related", async () => {
		for (const name of ["a", "b", "c", "d"]) {
			await writeFile(path.join(testContext.workspace, `${name}.ts`), `export const ${name} = 'Needle42';\n`);
		}
		const relatedText = "export function RelatedDefinition() { return 'other'; }\n";
		await writeFile(path.join(testContext.workspace, "related.ts"), relatedText);
		const unit = (await parseCodeUnits("related.ts", relatedText)).units.find((item) => item.name === "RelatedDefinition");
		if (unit === undefined) throw new Error("missing parsed fixture unit");
		const query = vi.fn(async (input): Promise<RepoMapQueryResult> => ({
			root: testContext.workspace,
			explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
			candidates: [repoMapCandidate("related.ts", relatedText, unit, ["definition"])],
		}));

		const result = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: "Needle42", match: "literal" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions).toHaveLength(4);
		expect(query).toHaveBeenCalledOnce();
		expect(result.related).toEqual([expect.objectContaining({ path: "related.ts", symbol: "RelatedDefinition" })]);
	});

	it("外部 direct symbol 不受本地 AST 单文件上限限制", async () => {
		const configPath = path.join(testContext.outside, "external-independent.jsonc");
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "a.ts"), "export const RemoteTarget = true;\n");
		await writeFile(path.join(testContext.workspace, "z.ts"), `export const unrelated = true;\n/* ${"padding".repeat(200)} */\n`);
		const symbols: GrepSymbolSource = {
			async query(input) {
				expect(input.allowedPaths).toContain("z.ts");
				return [{
					path: "z.ts",
					range: { startLine: 1, endLine: 1 },
					kind: "variable",
					symbol: "RemoteTarget",
					origin: "lsp-symbol",
					confidence: 1,
					relation: "definition",
					reasons: ["lsp exact symbol"],
				}];
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "RemoteTarget" }, { symbols }));
		expect(result.regions).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "z.ts", symbol: "RemoteTarget", sources: ["lsp-symbol"], query_match: "semantic" }),
		]));
	});

	it("多 scope 外部查询保留各自完整 allowed paths，并按文件 identity 去重", async () => {
		await mkdir(path.join(testContext.workspace, "src"));
		await writeFile(path.join(testContext.workspace, "src", "target.ts"), "export const unrelated = true;\n");
		await writeFile(path.join(testContext.workspace, "root.ts"), "export const rootOnly = true;\n");
		const calls: Array<{ readonly root: string; readonly allowed: readonly string[] }> = [];
		const candidate: GrepExternalCandidate = {
			path: "src/target.ts",
			range: { startLine: 1, endLine: 1 },
			kind: "variable",
			symbol: "RemoteTarget",
			origin: "lsp-symbol",
			confidence: 1,
			relation: "definition",
			reasons: ["lsp exact symbol"],
		};
		const symbols: GrepSymbolSource = {
			async query(input) {
				calls.push({ root: input.root.displayPath, allowed: input.allowedPaths });
				return [candidate];
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { path: [".", "src"], query: "RemoteTarget" }, { symbols }));
		expect(calls).toEqual([
			{ root: ".", allowed: ["root.ts", "src/target.ts"] },
			{ root: "src", allowed: ["src/target.ts"] },
		]);
		expect(result.regions.filter((region) => region.path === "src/target.ts")).toHaveLength(1);
	});

	it("统一 validator 排除 stale hash/version、非法 range、scope 外和缺失文件", async () => {
		await mkdir(path.join(testContext.workspace, "scope"));
		const content = "你 export const current = true;\n";
		await writeFile(path.join(testContext.workspace, "scope", "valid.ts"), content);
		await writeFile(path.join(testContext.workspace, "outside.ts"), content);
		const hash = createHash("sha256").update(content).digest("hex");
		const graph: GrepGraphSource = {
			async query() {
				const base = {
					range: { startLine: 1, endLine: 1 },
					kind: "variable",
					symbol: "RemoteTarget",
					origin: "repo-map" as const,
					confidence: 1,
					hop: 0 as const,
					relation: "definition",
					reasons: ["definition"],
				};
				return [
					{ ...base, path: "scope/valid.ts", contentHash: hash },
					{ ...base, path: "scope/valid.ts", symbol: "StaleHash", contentHash: "stale" },
					{ ...base, path: "scope/valid.ts", symbol: "StaleVersion", contentVersion: "stale" },
					{ ...base, path: "scope/valid.ts", symbol: "InvalidRange", range: { startLine: 9, endLine: 10 }, contentHash: hash },
					{ ...base, path: "scope/valid.ts", symbol: "InvalidBytes", range: { startLine: 2, endLine: 2, startByte: 0, endByte: 1 }, contentHash: hash },
					{ ...base, path: "scope/valid.ts", symbol: "PartialBytes", range: { startLine: 1, endLine: 1, startByte: 0 }, contentHash: hash },
					{ ...base, path: "scope/valid.ts", symbol: "SplitUtf8", range: { startLine: 1, endLine: 1, startByte: 1, endByte: 3 }, contentHash: hash },
					{ ...base, path: "scope/valid.ts", symbol: "FractionalLine", range: { startLine: 1.5, endLine: 1 }, contentHash: hash },
					{ ...base, path: "outside.ts", symbol: "Outside", contentHash: hash },
					{ ...base, path: "scope/missing.ts", symbol: "Missing", contentHash: hash },
				];
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { path: ["scope"], query: "RemoteTarget" }, { graph }));
		expect(result.regions.map((region) => region.symbol)).toEqual(["RemoteTarget"]);
		expect(result.related).toBeUndefined();
	});

	it("外部候选返回前文件变化会被 live metadata gate 排除", async () => {
		await writeFile(path.join(testContext.workspace, "changed.txt"), "before\n");
		const scanCompleted = deferredVoid();
		const symbols: GrepSymbolSource = {
			async query() {
				await scanCompleted.promise;
				await writeFile(path.join(testContext.workspace, "changed.txt"), "after changed\n");
				return [{
					path: "changed.txt",
					range: { startLine: 1, endLine: 1 },
					kind: "variable",
					symbol: "RemoteTarget",
					origin: "lsp-symbol",
					confidence: 1,
					relation: "definition",
					reasons: ["lsp exact symbol"],
				}];
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "RemoteTarget" }, { symbols }, (filesystem) => {
			const original = filesystem.content;
			return {
				...filesystem,
				content: {
					readBytes: original.readBytes.bind(original),
					readText: original.readText.bind(original),
					decodeText: original.decodeText.bind(original),
					sliceText: original.sliceText.bind(original),
					async scanLines(file, options, context) {
						const opened = await original.scanLines(file, options, context);
						if (!opened.ok) return opened;
						return { ok: true, value: {
							[Symbol.asyncIterator]: opened.value[Symbol.asyncIterator].bind(opened.value),
							async close() {
								await opened.value.close();
								scanCompleted.resolve();
							},
						} };
					},
				},
			};
		}));
		expect(result.regions).toEqual([]);
		expect(result.related).toBeUndefined();
	});

	it("无 hash/version 外部候选不会越过 stat 后发生的同 size snapshot 变化", async () => {
		const filePath = path.join(testContext.workspace, "external-race.ts");
		const originalText = "export const before = true;\n";
		const replacementText = "export const after_ = true;\n";
		expect(Buffer.byteLength(replacementText)).toBe(Buffer.byteLength(originalText));
		await writeFile(filePath, originalText);
		const symbols: GrepSymbolSource = {
			async query() {
				return [{
					path: "external-race.ts",
					range: { startLine: 1, endLine: 1 },
					kind: "variable",
					symbol: "RemoteTarget",
					origin: "lsp-symbol",
					confidence: 1,
					relation: "definition",
					reasons: ["lsp exact symbol"],
				}];
			},
		};
		let changed = false;
		let metadataReads = 0;
		const result = expectGrepSuccess(await grepWithSources(
			testContext.workspace,
			{ query: "MissingNeedle", match: "literal" },
			{ symbols },
			(filesystem) => {
				const originalContent = filesystem.content;
				const originalMetadata = filesystem.metadata;
				return {
					...filesystem,
					metadata: {
						...originalMetadata,
						async stat(ref, context) {
							metadataReads += 1;
							return await originalMetadata.stat(ref, context);
						},
					},
					content: {
						readBytes: originalContent.readBytes.bind(originalContent),
						async readText(file, options, context) {
							expect(options.expectedSnapshot).toBeDefined();
							if (!changed) {
								changed = true;
								await writeFile(filePath, replacementText);
								await utimes(filePath, new Date(946_684_800_000), new Date(946_684_800_000));
							}
							return await originalContent.readText(file, options, context);
						},
						decodeText: originalContent.decodeText.bind(originalContent),
						sliceText: originalContent.sliceText.bind(originalContent),
						scanLines: originalContent.scanLines.bind(originalContent),
					},
				};
			},
		));
		expect(result.regions).toEqual([]);
		expect(result.related).toBeUndefined();
		expect(changed).toBe(true);
		expect(metadataReads).toBe(0);
	});

	it("inventory 后文本与外部通道并行启动", async () => {
		await writeFile(path.join(testContext.workspace, "parallel.txt"), "needle\n");
		const externalStarted = deferredVoid();
		const scanStarted = deferredVoid();
		const symbols: GrepSymbolSource = {
			async query() {
				externalStarted.resolve();
				await scanStarted.promise;
				return [];
			},
		};
		const result = await grepWithSources(testContext.workspace, { query: "needle" }, { symbols }, (filesystem) => {
			const original = filesystem.content;
			return {
				...filesystem,
				content: {
					readBytes: original.readBytes.bind(original),
					readText: original.readText.bind(original),
					decodeText: original.decodeText.bind(original),
					sliceText: original.sliceText.bind(original),
					async scanLines(file, options, context) {
						scanStarted.resolve();
						await externalStarted.promise;
						return await original.scanLines(file, options, context);
					},
				},
			};
		});
		expect(result.status).toBe("success");
	});

	it("text、AST、LSP 和 Repo Map 的同一区域只输出一次并合并 evidence family", async () => {
		const content = "export function Target() { return Target; }\n";
		await writeFile(path.join(testContext.workspace, "target.ts"), content);
		const unit = (await parseCodeUnits("target.ts", content)).units.find((item) => item.name === "Target");
		if (unit === undefined) throw new Error("missing parsed fixture unit");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Target" }, undefined, {
			lsp: {
				async symbols() {
					return [{ path: "target.ts", start_line: unit.startLine, end_line: unit.endLine, kind: unit.kind, symbol: "Target", exact: true, origin: "workspace-symbol" }];
				},
			},
			repoMap: repoMapQuery(async (input) => ({
				root: testContext.workspace,
				explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
				candidates: [repoMapCandidate("target.ts", content, unit, ["definition"])],
			})),
		}));
		const matches = result.regions.filter((region) => region.path === "target.ts" && region.symbol === "Target");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.sources).toEqual(expect.arrayContaining(["text-literal", "ast-symbol", "lsp-symbol", "repo-map-direct"]));
	});

	it("相同 symbol/range 的不同 overload signature 不误合并", async () => {
		await writeFile(path.join(testContext.workspace, "overload.ts"), "export const unrelated = true;\n");
		const symbols: GrepSymbolSource = {
			async query() {
				return ["string", "number"].map((type): GrepExternalCandidate => ({
					path: "overload.ts",
					range: { startLine: 1, endLine: 1 },
					kind: "function",
					symbol: "Target",
					signature: `function Target(value: ${type})`,
					origin: "lsp-symbol",
					confidence: 1,
					relation: "definition",
					reasons: ["lsp exact symbol"],
				}));
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "Target" }, { symbols }));
		expect(result.regions.map((region) => region.declaration)).toEqual([
			"function Target(value: string)",
			"function Target(value: number)",
		]);
	});

	it("LSP reference 仅在显式 relation intent 下进入 main", async () => {
		await writeFile(path.join(testContext.workspace, "caller.ts"), "export function caller() { return login(); }\n");
		const symbols: GrepSymbolSource = {
			async query() {
				return [{
					path: "caller.ts",
					range: { startLine: 1, endLine: 1 },
					kind: "reference",
					symbol: "login",
					origin: "lsp-reference",
					confidence: 1,
					relation: "reference",
					reasons: ["lsp reference"],
				}];
			},
		};
		const ordinary = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "MissingLogin" }, { symbols }));
		expect(ordinary.regions.some((region) => region.sources.includes("lsp-reference"))).toBe(false);
		expect(ordinary.related).toEqual([expect.objectContaining({ path: "caller.ts", relations: ["reference"] })]);
		const explicit = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "references to login" }, { symbols }));
		expect(explicit.regions).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "caller.ts", sources: ["lsp-reference"], query_match: "semantic" }),
		]));
	});

	it("strict 仅用外部证据增强 verified region，不伪造 match_lines", async () => {
		const content = "export function target() { return 'Needle42'; }\n";
		await writeFile(path.join(testContext.workspace, "target.ts"), content);
		const symbols: GrepSymbolSource = {
			async query() {
				return [{
					path: "target.ts",
					range: { startLine: 1, endLine: 1 },
					kind: "function",
					symbol: "target",
					origin: "lsp-symbol",
					confidence: 1,
					relation: "definition",
					reasons: ["lsp exact symbol"],
				}];
			},
		};
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "Needle42", match: "literal" }, { symbols }));
		expect(result.regions).toEqual([
			expect.objectContaining({ query_match: "verified", match_lines: [1], sources: expect.arrayContaining(["text-literal", "lsp-symbol"]) }),
		]);
		await assertStrictMatches(testContext.workspace, result, "Needle42", "literal");
	});

	it("caller 取消时不等待忽略 signal 的外部来源", async () => {
		await writeFile(path.join(testContext.workspace, "cancel-external.txt"), "needle\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-external-cancel" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const started = deferredVoid();
		const symbols: GrepSymbolSource = {
			async query() {
				started.resolve();
				return await new Promise<readonly GrepExternalCandidate[]>(() => {});
			},
		};
		const controller = new AbortController();
		try {
			const active = tool.execute({ query: "needle" }, {
				filesystem: opened.filesystem,
				operation: { signal: controller.signal },
				limits: opened.limits,
				symbols,
			});
			await started.promise;
			controller.abort();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("外部超时式拒绝仅降级对应通道", async () => {
		await writeFile(path.join(testContext.workspace, "timeout.ts"), "export const TimeoutNeedle = true;\n");
		const symbols: GrepSymbolSource = { query() { throw new Error("LSP timeout"); } };
		const graph: GrepGraphSource = { async query() { throw new Error("Repo Map timeout"); } };
		const result = expectGrepSuccess(await grepWithSources(testContext.workspace, { query: "TimeoutNeedle" }, { symbols, graph }));
		expect(firstRegion(result)).toMatchObject({ path: "timeout.ts", query_match: "verified" });
	});

	it("Repo Map related edge 的 stale hash 不进入 related", async () => {
		const content = "export function Target() { return true; }\n";
		const relatedContent = "export function Related() { return true; }\n";
		await writeFile(path.join(testContext.workspace, "target.ts"), content);
		await writeFile(path.join(testContext.workspace, "related.ts"), relatedContent);
		const unit = (await parseCodeUnits("target.ts", content)).units.find((item) => item.name === "Target");
		if (unit === undefined) throw new Error("missing parsed fixture unit");
		const candidate = repoMapCandidate("target.ts", content, unit, ["definition"]);
		candidate.relatedEdges.push({
			kind: "calls",
			from: unit.id,
			to: "file:related.ts",
			confidence: 1,
			resolution: "semantic",
			source: "tree-sitter",
			hop: 1,
			evidence: [],
			relatedFiles: [{ path: "related.ts", contentHash: "stale" }],
		});
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Target" }, undefined, {
			repoMap: repoMapQuery(async (input) => ({
				root: testContext.workspace,
				explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
				candidates: [candidate],
			})),
		}));
		expect(result.related?.some((item) => item.path === "related.ts")).not.toBe(true);
	});

	it("最终协议以候选 sources 和具体截断原因解释结果", () => {
		const native = packCandidate({ id: "native", path: "native.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const structural = packCandidate({
			id: "structural",
			path: "structural.ts",
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
			evidence: [rankingEvidence("text-literal"), rankingEvidence("repo-map-direct")],
		});
		const result = packGrepResults({
			query: "needle",
			path: ".",
			match: "literal",
			totalCandidates: 2,
			regions: [native, structural],
			stats: { traversed_entries: 2, searched_files: 2, searched_bytes: 2, parsed_files: 0 },
			truncationReasons: [],
			tokenBudget: 200,
			resultLimit: 1,
			regionalDisplayLimit: 3,
			nearby: [],
			related: [],
		});

		expect(firstRegion(result).sources).toEqual(["text-literal"]);
		expect(result.truncated_by).toEqual(["result_limit"]);
		expect(formatCompactGrepResult(result)).toContain('<grep truncated="result_limit">');
		expect(formatCompactGrepResult(result)).not.toContain("repo-map");
	});

	it("无 symbol/range 的 Repo Map 文件候选不会投影到 units[0]", async () => {
		const content = "export function FirstFunction() { return 1; }\nexport function SecondFunction() { return 2; }\n";
		await writeFile(path.join(testContext.workspace, "ambiguous.ts"), content);
		const candidate: RepoMapQueryCandidate = {
			path: "ambiguous.ts",
			fileId: "file:ambiguous.ts",
			contentHash: createHash("sha256").update(content).digest("hex"),
			score: 900,
			confidence: 1,
			hop: 0,
			reasons: ["definition"],
			matchedAliases: [],
			relatedEdges: [],
		};
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "MissingTarget" }, undefined, {
			repoMap: repoMapQuery(async (input) => ({
				root: testContext.workspace,
				explanation: { queryTerms: [input.query], expandedTerms: [input.query], seedCount: 1, maxHop: 2 },
				candidates: [candidate],
			})),
		}));
		expect(result.regions.some((region) => region.symbol === "FirstFunction")).toBe(false);
		expect(result.related).toEqual([expect.objectContaining({ path: "ambiguous.ts", kind: "file" })]);
		expect(result.related?.[0]?.symbol).toBeUndefined();
	});

	it.each(["literal", "regex"] as const)("%s 在 repo-map 失败时保持事实结果不变", async (match) => {
		const content = "export function Target() { return 'Needle42'; }\n";
		await writeFile(path.join(testContext.workspace, "target.ts"), content);
		const queryText = match === "literal" ? "Needle42" : "Needle\\d+";
		const baseline = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: queryText, match }));
		clearGrepIndex();
		const query = vi.fn(async () => { throw new Error("repo-map unavailable"); });
		const degraded = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: queryText, match },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(query).toHaveBeenCalledOnce();
		expect(degraded).toEqual(baseline);
	});

	it("无字面标识片段的 regex 在外部空结果时仍保留事实命中", async () => {
		await writeFile(path.join(testContext.workspace, "number.ts"), "export const value = 42;\n");
		const query = vi.fn(async (): Promise<RepoMapQueryResult | undefined> => undefined);
		const result = expectGrepSuccess(await grepWorkspaceFiles(
			testContext.workspace,
			{ query: "\\d+", match: "regex" },
			undefined,
			{ repoMap: repoMapQuery(query) },
		));

		expect(result.regions.length).toBeGreaterThan(0);
		expect(query).toHaveBeenCalledOnce();
	});

	it("超大函数只返回稳定 enclosing identity、declaration 和命中行", async () => {
		const configPath = path.join(testContext.outside, "small-budget.jsonc");
		await writeConfig(configPath, { grep_output_token_budget: 220, grep_result_limit: 4 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		const body = Array.from({ length: 80 }, (_, index) => `  const value${index} = ${index};`).join("\n");
		await writeFile(path.join(testContext.workspace, "large.ts"), `export function hugeFunction() {\n${body}\n  return needle;\n}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({
			kind: "function",
			symbol: "hugeFunction",
			declaration: "export function hugeFunction()",
			query_match: "verified",
			display_lines: [expect.objectContaining({ line: 82, text: expect.stringContaining("needle"), type: "match" })],
		});
		expect(formatCompactGrepResult(result)).not.toContain("lines omitted");
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(220);
	});

	it("普通 symbol 查询优先生产 prefix，显式 test 查询恢复测试优先级", async () => {
		await writeFile(path.join(testContext.workspace, "grep-runtime.ts"), "export function grepAuto() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "grep-runtime.test.ts"), "export const grep = () => true;\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "grep" }));
		expect(firstRegion(result)).toMatchObject({ path: "grep-runtime.ts", symbol: "grepAuto" });
		expect(result.regions.find((region) => region.path === "grep-runtime.test.ts")?.matched_by).toContain("exact-symbol");
		expect(result.regions.find((region) => region.path === "grep-runtime.test.ts")?.matched_by).not.toContain("exact-qualified-symbol");
		const tests = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "tests for grep" }));
		expect(firstRegion(tests).path).toBe("grep-runtime.test.ts");
	});

	it("多文件结果先覆盖不同文件，test 查询把测试意图作为来源内排序依据", async () => {
		await writeFile(path.join(testContext.workspace, "service.ts"), "export function login() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "service.test.ts"), "export function loginTest() { return login(); }\n");
		await writeFile(path.join(testContext.workspace, "controller.ts"), "export function handleLogin() { return login(); }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(new Set(result.regions.slice(0, 3).map((region) => region.path)).size).toBeGreaterThan(1);
		expect(firstRegion(result).path).not.toContain("test");
		const testResult = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login test" }));
		expect(testResult.regions[0]?.path).toContain("test");
	});
});
