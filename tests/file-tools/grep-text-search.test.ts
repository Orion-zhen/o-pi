import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { buildScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { packGrepResults, renderGrepSuccess } from "../../src/file-tools/grep/packer.js";
import { scanInventoryText } from "../../src/file-tools/grep/text-scanner.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { formatCompactGrepResult } from "../../src/file-tools/grep/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { createGrepTestContext, expectGrepSuccess, expectInventorySuccess, firstRegion, assertStrictMatches, writeConfig } from "./grep-fixtures.js";
import { packCandidate, packRegions, queryPlan } from "./grep-ranking-fixtures.js";

const testContext = createGrepTestContext();

describe("grep text search", () => {
	it.each(["/absolute.ts", "../escape.ts", "a/../escape.ts", "bad\0glob"])("拒绝越界或 NUL glob %j", async (glob) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query: "needle", glob })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it.each([
		{ match: "literal" as const, query: "needle\nnext" },
		{ match: "literal" as const, query: "needle\rnext" },
		{ match: "regex" as const, query: "needle\nnext" },
		{ match: "regex" as const, query: "needle\rnext" },
	])("$match 拒绝 CR/LF 多行 query", async ({ match, query }) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query, match })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it.each([
		["LF", "alpha\nNeedle42\nomega\n"],
		["CRLF", "alpha\r\nNeedle42\r\nomega\r\n"],
		["CR", "alpha\rNeedle42\romega\r"],
	] as const)("literal 对 %s 使用统一 logical line 语义", async (_newline, content) => {
		await writeFile(path.join(testContext.workspace, "lines.txt"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ match_lines: [2], query_match: "verified" });
		expect(firstRegion(result).content).toContain("Needle42");
	});

	it("regex 正确处理空行、UTF-8 BOM、逐行状态重置和无字面锚点表达式", async () => {
		await writeFile(path.join(testContext.workspace, "empty.txt"), "value\n\n");
		const empty = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["empty.txt"], query: "^$", match: "regex" }));
		expect(empty.regions.map((region) => region.match_lines)).toEqual([[2]]);

		await writeFile(path.join(testContext.workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Needle42\n")]));
		const bom = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["bom.txt"], query: "^Needle\\d+$", match: "regex" }));
		expect(firstRegion(bom)).toMatchObject({ match_lines: [1] });
		expect(firstRegion(bom).content).toBe("Needle42");

		await writeFile(path.join(testContext.workspace, "state.txt"), "a1\na2\n---\n");
		const reset = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "\\d", match: "regex" }));
		expect(reset.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const anchorless = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "^[-]+$", match: "regex" }));
		expect(anchorless.regions.map((region) => region.match_lines)).toEqual([[3]]);
	});

	it("中文注释 literal 只返回携带可复核 match_lines 的真实文本窗口", async () => {
		const query = "Repo Map 使用的详细结果；保留 parser 失败状态与文件级 import 事实。";
		await writeFile(path.join(testContext.workspace, "design.ts"), `export const unrelated = true;\n// ${query}\nexport function lexicalOnly() { return unrelated; }\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match: "literal" }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result)).toMatchObject({ path: "design.ts", kind: "text", match_lines: [2], query_match: "verified" });
		await assertStrictMatches(testContext.workspace, result, query, "literal");
	});

	it.each([
		["literal", "LargeNeedle"],
		["regex", "LargeNeed\\w+"],
	] as const)("%s 可流式搜索超过旧 1 MiB 和 parse 上限的文件", async (match, query) => {
		const configPath = path.join(testContext.outside, `large-${match}.jsonc`);
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "large.txt"), `${"padding\n".repeat(140_000)}LargeNeedle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match }));
		expect(firstRegion(result)).toMatchObject({ path: "large.txt", query_match: "verified" });
		expect(result.stats.searched_bytes).toBeGreaterThan(1024 * 1024);
		expect(result.stats.parsed_files).toBe(0);
	});

	it("正文扫描不按文件数量或累计字节提前停止", async () => {
		await writeFile(path.join(testContext.workspace, "a.txt"), `Needle42\n${"a".repeat(700)}`);
		await writeFile(path.join(testContext.workspace, "b.txt"), `Needle42\n${"b".repeat(700)}`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42", match: "literal" }));
		expect(result.regions.map((region) => region.path)).toEqual(["a.txt", "b.txt"]);
		expect(result.stats).toMatchObject({ searched_files: 2, searched_bytes: 1418, parsed_files: 0 });
		expect(result.truncated_by).not.toContain("traversal_limit");
	});

	it("TextScanner 以正文 UTF-8 坐标存储 BOM 后的多字节命中并显式报告候选截断", async () => {
		const lines = "你😀hit\n你😀hit\n你😀hit\n你😀hit\n你😀hit\n";
		await writeFile(path.join(testContext.workspace, "hits.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines)]));
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-hit-limit" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const inventory = expectInventorySuccess(await buildScopeInventory({ paths: ["hits.txt"] }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxDepth: 12,
			}));
			const scanned = await scanInventoryText(inventory, queryPlan("hit", "literal"), {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxStoredHits: 2,
			});
			if (isFailed(scanned)) throw new Error(scanned.error.message);
			expect(scanned.hits).toHaveLength(2);
			expect(scanned.hits[0]).toMatchObject({
				line: 1,
				byteStart: 7,
				byteEnd: 10,
				before: [],
				after: ["你😀hit", "你😀hit"],
			});
			expect(scanned.totalHits).toBe(5);
			expect(scanned.truncationReasons).toEqual(["semantic_candidate_limit"]);
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("inventory 后 identity 替换时 TextScanner 丢弃旧快照并区分递归跳过与显式错误", async () => {
		const filePath = path.join(testContext.workspace, "snapshot-race.txt");
		const replacementPath = path.join(testContext.outside, "snapshot-replacement.txt");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-snapshot-race" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			for (const [paths, explicit] of [[["."], false], [["snapshot-race.txt"], true]] as const) {
				await writeFile(filePath, "needle\n");
				await writeFile(replacementPath, "current");
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxDepth: 12,
				}));
				await rm(filePath);
				await rename(replacementPath, filePath);
				const scanned = await scanInventoryText(inventory, queryPlan("needle", "literal"), {
					filesystem: opened.filesystem,
					operation: opened.context,
				});
				if (isFailed(scanned)) throw new Error(scanned.error.message);
				expect(scanned.hits).toEqual([]);
				expect(scanned.stats.searchedFiles).toBe(0);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("TextScanner 丢弃 changed-during-read 的部分命中并区分递归跳过与显式错误", async () => {
		await writeFile(path.join(testContext.workspace, "race.txt"), "needle\n");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-changed-scan" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let closes = 0;
		const content: ContentOperations = {
			readBytes: opened.filesystem.content.readBytes.bind(opened.filesystem.content),
			readText: opened.filesystem.content.readText.bind(opened.filesystem.content),
			decodeText: opened.filesystem.content.decodeText.bind(opened.filesystem.content),
			sliceText: opened.filesystem.content.sliceText.bind(opened.filesystem.content),
			async scanLines() {
				return { ok: true, value: {
					async *[Symbol.asyncIterator]() {
						yield { ok: true as const, value: { line: 1, text: "needle", byteStart: 0, byteEnd: 6 } };
						yield { ok: false as const, error: { code: "changed-during-read" as const, message: "changed", path: "race.txt" } };
					},
					async close() { closes += 1; },
				} };
			},
		};
		const filesystem: WorkspaceFileSystem = { ...opened.filesystem, content };
		try {
			for (const [paths, explicit] of [[["."], false], [["race.txt"], true]] as const) {
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem,
					operation: opened.context,
					maxDepth: 12,
				}));
				const scanned = await scanInventoryText(inventory, queryPlan("needle", "literal"), {
					filesystem,
					operation: opened.context,
				});
				if (isFailed(scanned)) throw new Error(scanned.error.message);
				expect(scanned.hits).toEqual([]);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
			expect(closes).toBe(2);
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("auto 保留现有多行 query 语义", async () => {
		await writeFile(path.join(testContext.workspace, "multiline.txt"), "needle\nnext\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle\nnext", match: "auto" }));
		expect(result.regions).toEqual([]);
	});

	it("紧凑输出的 signature 模式保留完整签名", () => {
		const output = renderGrepSuccess({
			status: "success",
			query: "handler",
			path: ".",
			match: "auto",
			total_candidates: 2,
			returned_regions: 2,
			returned_files: 2,
			approx_tokens: 0,
			stats: { traversed_entries: 2, searched_files: 2, searched_bytes: 100, parsed_files: 2 },
			truncated_by: [],
			regions: [
				{
					path: "src/features/authentication/first-handler.ts",
					start_line: 1,
					end_line: 3,
					kind: "function",
					symbol: "firstHandler",
					signature: "function firstHandler(input: AuthInput): Session",
					detail: "signature",
					query_match: "semantic",
					reasons: ["exact symbol"],
					sources: ["ast-symbol"],
				},
				{
					path: "src/features/authentication/second-handler.ts",
					start_line: 5,
					end_line: 7,
					kind: "function",
					symbol: "secondHandler",
					detail: "signature",
					query_match: "semantic",
					reasons: ["caller"],
					sources: ["ast-graph"],
				},
			],
		});

		expect(output).toContain("src/features/authentication/first-handler.ts:1-3 function firstHandler(input: AuthInput): Session [exact symbol]");
	});

	it("strict 匹配行本身超预算时跳过候选而不伪装成 signature 命中", () => {
		const longLine = `  const value = '${"needle".repeat(80)}';\n`;
		const source = `export function oversizedNeedle(): string {\n${longLine.repeat(80)}  return value;\n}\n`;
		const candidate = packCandidate({
			id: "oversized",
			path: "src/oversized.ts",
			startLine: 1,
			endLine: 83,
			endByte: Buffer.byteLength(source),
			matchLine: 40,
			symbol: "oversizedNeedle",
			signature: "function oversizedNeedle(): string",
		});
		const result = packGrepResults({
			query: "needle",
			path: ".",
			match: "literal",
			totalCandidates: 1,
			regions: [candidate],
			sourceText: new Map([[candidate.path, source]]),
			snippets: new Map(),
			stats: { traversed_entries: 1, searched_files: 1, searched_bytes: Buffer.byteLength(source), parsed_files: 1 },
			truncationReasons: [],
			tokenBudget: 100,
			resultLimit: 1,
			nearby: [],
			related: [],
		});

		expect(result.regions).toEqual([]);
		expect(result.truncated_by).toContain("token_budget");
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(100);
	});

	it("预算选择将大型函数压缩为匹配窗口以保留更多条目", () => {
		const source = [
			"export function largeNeedle() {",
			...Array.from({ length: 70 }, (_, index) => `  const padding${index} = '${"value ".repeat(8)}';`),
			"  return needle;",
			"}",
		].join("\n");
		const large = packCandidate({
			id: "large",
			path: "a-large.ts",
			startLine: 1,
			endLine: 73,
			endByte: Buffer.byteLength(source),
			matchLine: 72,
			symbol: "largeNeedle",
			signature: "function largeNeedle()",
		});
		const second = packCandidate({ id: "second-window", path: "b.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third-window", path: "c.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([large, second, third], {
			resultLimit: 3,
			tokenBudget: 180,
			sourceText: new Map([[large.path, source]]),
		});

		expect(result.regions.map((region) => region.path)).toEqual(["a-large.ts", "b.ts", "c.ts"]);
		expect(firstRegion(result)).toMatchObject({ detail: "snippet", match_lines: [72] });
		expect(firstRegion(result).content).toContain("return needle");
		expect(firstRegion(result).content).toContain("lines omitted");
		expect(firstRegion(result).content).not.toContain("padding0");
		expect(result.truncated_by).toContain("token_budget");
		expect(result.approx_tokens).toBeLessThanOrEqual(180);
	});

	it("超大 signature 被跳过后继续返回后续便宜候选，并稳定合并截断原因", () => {
		const hugeSignature = `function oversized(${Array.from({ length: 400 }, (_, index) => `parameter${index}: string`).join(", ")})`;
		const oversized = packCandidate({
			id: "oversized-signature",
			path: "a-oversized.ts",
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
			signature: hugeSignature,
		});
		const second = packCandidate({ id: "second", path: "b-second.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third", path: "c-third.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([oversized, second, third], {
			resultLimit: 2,
			tokenBudget: 180,
			truncationReasons: ["semantic_candidate_limit", "traversal_limit"],
		});

		expect(result.regions.map((region) => region.path)).toEqual(["b-second.ts", "c-third.ts"]);
		expect(result.truncated_by).toEqual([
			"traversal_limit",
			"semantic_candidate_limit",
			"result_limit",
			"token_budget",
		]);
		expect(result.approx_tokens).toBe(countTextTokensSync(formatCompactGrepResult(result)).tokens);
		expect(result.approx_tokens).toBeLessThanOrEqual(180);
	});

	it("nearby 只在 main 为空时占用预算，辅助候选超限后继续尝试", () => {
		const hugeSignature = `function oversized(${Array.from({ length: 400 }, (_, index) => `parameter${index}: string`).join(", ")})`;
		const nearby = [
			{ path: "a.ts", start_line: 1, end_line: 1, kind: "function", signature: hugeSignature, reason: "symbol similarity" as const, query_match: "not_guaranteed" as const },
			{ path: "b.ts", start_line: 1, end_line: 1, kind: "function", symbol: "near", reason: "symbol similarity" as const, query_match: "not_guaranteed" as const },
		];
		const related = [
			{ path: "c.ts", kind: "function", signature: hugeSignature, sources: ["repo-map-direct"], relations: ["test"], query_match: "not_guaranteed" as const },
			{ path: "d.ts", kind: "function", symbol: "related", sources: ["repo-map-direct"], relations: ["test"], query_match: "not_guaranteed" as const },
		];
		const empty = packRegions([], { nearby, related, tokenBudget: 140 });
		expect(empty.nearby?.map((item) => item.path)).toEqual(["b.ts"]);
		expect(empty.related?.map((item) => item.path)).toEqual(["d.ts"]);
		expect(empty.truncated_by).toEqual(["token_budget"]);
		expect(empty.approx_tokens).toBeLessThanOrEqual(140);

		const main = packCandidate({ id: "main", path: "main.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const cheapRelated = related[1];
		if (cheapRelated === undefined) throw new Error("missing related fixture");
		const withMain = packRegions([main], { nearby, related: [cheapRelated], tokenBudget: 140, resultLimit: 1 });
		expect(withMain.nearby).toBeUndefined();
		expect(withMain.related).toBeUndefined();
		expect(withMain.truncated_by).toContain("result_limit");
	});
});
