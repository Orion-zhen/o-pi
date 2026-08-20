import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { packGrepResults, renderGrepSuccess } from "../../src/file-tools/grep/packer.js";
import { scanInventoryText } from "../../src/file-tools/grep/text-scanner.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { formatCompactGrepResult } from "../../src/file-tools/grep/command.js";
import { compactDisplayLine } from "../../src/file-tools/grep/display.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import {
	assertStrictMatches,
	createGrepTestContext,
	expectGrepSuccess,
	expectInventorySuccess,
	expectSuccess,
	firstRegion,
	grepWithAnalyzer,
	overrideContent,
	withFileToolsInvocation,
	writeConfig,
} from "./grep-fixtures.js";
import { packCandidate, packRegions, queryPlan, rankingEvidence } from "./grep-ranking-fixtures.js";

const testContext = createGrepTestContext();

describe("grep text search", () => {
	it.each(["/absolute.ts", "../escape.ts", "a/../escape.ts", "bad\0glob"])("拒绝越界或 NUL glob %j", async (glob) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query: "needle", glob })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it.each(["needle\nnext", "needle\rnext"])("拒绝 CR/LF 多行 query %j", async (query) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it.each([
		["LF", "alpha\nNeedle42\nomega\n"],
		["CRLF", "alpha\r\nNeedle42\r\nomega\r\n"],
		["CR", "alpha\rNeedle42\romega\r"],
	] as const)("regex 对 %s 使用统一 logical line 语义", async (_newline, content) => {
		await writeFile(path.join(testContext.workspace, "lines.txt"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42" }));
		expect(firstRegion(result)).toMatchObject({ match_lines: [2], query_match: "verified" });
		expect(firstRegion(result).display_lines?.[0]?.text).toContain("Needle42");
	});

	it("非法正则仅在 exact literal 有正文命中时返回带警告的 fallback", async () => {
		await writeFile(path.join(testContext.workspace, "literal.ts"), "const value = read(input);\n");
		const analyzeCode = vi.fn(async () => undefined);
		const literal = expectGrepSuccess(await grepWithAnalyzer(testContext.workspace, {
			path: ["literal.ts"],
			query: "read(input",
		}, { analyzeCode }));
		expect(literal.query_mode).toBe("literal_fallback");
		expect(firstRegion(literal)).toMatchObject({
			query_match: "verified",
			matched_by: ["literal"],
			sources: ["text-literal"],
		});
		expect(formatCompactGrepResult(literal)).toContain("warning: invalid regex; exact literal fallback used");
		await assertStrictMatches(testContext.workspace, literal, "read(input");

		const malformedAlternation = await grepWithAnalyzer(testContext.workspace, {
			path: ["literal.ts"],
			query: "read(input|read:|ReadEnhancement|remainingSymbols|remaining_symbols",
		}, { analyzeCode });
		expect(malformedAlternation).toMatchObject({
			status: "failed",
			error: {
				code: "INVALID_REGEX",
				next: expect.stringContaining("opening parenthesis"),
			},
		});
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("AST 外文本使用单行协议，并对同一行的多个 occurrence 去重", async () => {
		await writeFile(path.join(testContext.workspace, "facts.conf"), "needle needle\n");
		const verified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["facts.conf"], query: "needle" }));
		expect(verified.regions).toHaveLength(1);
		expect(firstRegion(verified)).toMatchObject({ kind: "text", match_lines: [1], display_lines: [{ line: 1, text: "needle needle", type: "match" }] });
		expect(formatCompactGrepResult(verified)).toContain("facts.conf:1: needle needle");
		expect(formatCompactGrepResult(verified)).not.toContain("kind=text");

		await writeFile(path.join(testContext.workspace, "semantic.conf"), "authentication request rejected\n");
		const semantic = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["semantic.conf"], query: "authentication rejected" }));
		expect(firstRegion(semantic)).toMatchObject({ kind: "text", query_match: "semantic", matched_by: ["lexical"] });
		expect(formatCompactGrepResult(semantic)).toContain("semantic.conf:1 [not match, related]: authentication request rejected");
	});

	it("同文件 text region 只在模型文本中分组，候选和结果限制仍逐行计算", async () => {
		const configPath = path.join(testContext.outside, "text-render-group.jsonc");
		await writeConfig(configPath, { grep_result_limit: 2, grep_regional_display_limit: 1 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "grouped.conf"), [
			"needle first",
			"needle second",
			"needle third",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["grouped.conf"],
			query: "needle",
		}));
		expect(result).toMatchObject({
			total_candidates: 3,
			returned_regions: 2,
			returned_files: 1,
			truncated_by: ["result_limit"],
		});
		expect(result.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const output = formatCompactGrepResult(result);
		expect(output).toContain("grouped.conf:\n  1: needle first\n  2: needle second");
		expect(output.match(/grouped\.conf/g)).toHaveLength(1);
	});

	it("超长 Unicode 行围绕真实匹配点安全截取", async () => {
		const line = `${"前".repeat(300)}😀needle目标${"后".repeat(300)}`;
		await writeFile(path.join(testContext.workspace, "unicode.conf"), `${line}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		const evidence = firstRegion(result).display_lines?.[0]?.text;
		expect(evidence).toBeDefined();
		expect([...(evidence ?? "")]).toHaveLength(240);
		expect(evidence).toContain("😀needle目标");
		expect(evidence?.startsWith("...")).toBe(true);
		expect(evidence?.endsWith("...")).toBe(true);
	});

	it.each([
		{
			name: "行首",
			line: `needle目标${"后".repeat(400)}`,
			start: 0,
			end: 6,
			assertion: (value: string) => value.startsWith("needle目标") && value.endsWith("..."),
		},
		{
			name: "行尾",
			line: `${"前".repeat(400)}目标needle`,
			start: 402,
			end: 408,
			assertion: (value: string) => value.startsWith("...") && value.endsWith("目标needle"),
		},
		{
			name: "超长匹配本身",
			line: `prefix${"😀".repeat(300)}suffix`,
			start: 6,
			end: 606,
			assertion: (value: string) => value.includes("😀".repeat(100)),
		},
	])("证据截取覆盖$name匹配", ({ line, start, end, assertion }) => {
		const compact = compactDisplayLine(line, start, end);
		expect([...compact]).toHaveLength(240);
		expect(assertion(compact)).toBe(true);
	});

	it("regex 正确处理空行、UTF-8 BOM、逐行状态重置和无字面锚点表达式", async () => {
		await writeFile(path.join(testContext.workspace, "empty.txt"), "value\n\n");
		const empty = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["empty.txt"], query: "^$" }));
		expect(empty.regions.map((region) => region.match_lines)).toEqual([[2]]);

		await writeFile(path.join(testContext.workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Needle42\n")]));
		const bom = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["bom.txt"], query: "^Needle\\d+$" }));
		expect(firstRegion(bom)).toMatchObject({ match_lines: [1] });
		expect(firstRegion(bom).display_lines?.[0]?.text).toBe("Needle42");

		await writeFile(path.join(testContext.workspace, "state.txt"), "a1\na2\n---\n");
		const reset = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "\\d" }));
		expect(reset.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const anchorless = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "^[-]+$" }));
		expect(anchorless.regions.map((region) => region.match_lines)).toEqual([[3]]);
	});

	it("中文注释 regex 只返回携带可复核 match_lines 的真实文本行", async () => {
		const query = "代码索引使用的详细结果；保留 parser 失败状态与文件级 import 事实。";
		await writeFile(path.join(testContext.workspace, "design.ts"), `export const unrelated = true;\n// ${query}\nexport function lexicalOnly() { return unrelated; }\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result)).toMatchObject({ path: "design.ts", kind: "text", match_lines: [2], query_match: "verified" });
		await assertStrictMatches(testContext.workspace, result, query);
	});

	it.each(["LargeNeedle", "LargeNeed\\w+"])("query=%s 可流式搜索超过旧 1 MiB 和 parse 上限的文件", async (query) => {
		const configPath = path.join(testContext.outside, "large.jsonc");
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "large.txt"), `${"padding\n".repeat(140_000)}LargeNeedle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(firstRegion(result)).toMatchObject({ path: "large.txt", query_match: "verified" });
		expect(result.stats.searched_bytes).toBeGreaterThan(1024 * 1024);
		expect(result.stats.parsed_files).toBe(0);
	});

	it("累计正文预算在下一文件前停止扫描并报告 byte_limit", async () => {
		const configPath = path.join(testContext.outside, "byte-limit.jsonc");
		await writeConfig(configPath, { grep_max_search_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "a.txt"), `Needle42\n${"a".repeat(700)}`);
		await writeFile(path.join(testContext.workspace, "b.txt"), `Needle42\n${"b".repeat(700)}`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42" }));
		expect(result.regions.map((region) => region.path)).toEqual(["a.txt"]);
		expect(result.stats).toMatchObject({ searched_files: 1, searched_bytes: 709, parsed_files: 0 });
		expect(result.truncated_by).toContain("byte_limit");
	});

	it("TextScanner 以正文 UTF-8 坐标存储 BOM 后的多字节命中并观测未保存命中数", async () => {
		const lines = "你😀hit\n你😀hit\n你😀hit\n你😀hit\n你😀hit\n";
		await writeFile(path.join(testContext.workspace, "hits.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines)]));
		await withFileToolsInvocation(testContext.workspace, "grep-hit-limit", async (opened) => {
			const inventory = expectInventorySuccess(await buildScopeInventory({ paths: ["hits.txt"] }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxDepth: 12,
				maxEntries: 100_000,
			}));
			const scanned = expectSuccess(await scanInventoryText(inventory, queryPlan("hit"), {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxStoredHits: 2,
				maxStoredAnchors: 2,
			}));
			expect(scanned.hits).toHaveLength(2);
			expect(scanned.hits[0]).toMatchObject({
				line: 1,
				byteStart: 7,
				byteEnd: 10,
				matchStart: 3,
				matchEnd: 6,
			});
			expect(scanned.totalHits).toBe(5);
			expect(scanned.stats).toMatchObject({
				droppedTextHits: 3,
				droppedRelatedAnchors: 3,
			});
		});
	});

	it("inventory 后 identity 替换时 TextScanner 丢弃旧快照并区分递归跳过与显式错误", async () => {
		const filePath = path.join(testContext.workspace, "snapshot-race.txt");
		const replacementPath = path.join(testContext.outside, "snapshot-replacement.txt");
		await withFileToolsInvocation(testContext.workspace, "grep-snapshot-race", async (opened) => {
			for (const [paths, explicit] of [[["."], false], [["snapshot-race.txt"], true]] as const) {
				await writeFile(filePath, "needle\n");
				await writeFile(replacementPath, "current");
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxDepth: 12,
					maxEntries: 100_000,
				}));
				await rm(filePath);
				await rename(replacementPath, filePath);
				const scanned = expectSuccess(await scanInventoryText(inventory, queryPlan("needle"), {
					filesystem: opened.filesystem,
					operation: opened.context,
				}));
				expect(scanned.hits).toEqual([]);
				expect(scanned.stats.searchedFiles).toBe(0);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
		});
	});

	it("TextScanner 丢弃 changed-during-read 的部分命中并区分递归跳过与显式错误", async () => {
		await writeFile(path.join(testContext.workspace, "race.txt"), "needle\n");
		await withFileToolsInvocation(testContext.workspace, "grep-changed-scan", async (opened) => {
			let closes = 0;
			const filesystem = overrideContent(opened.filesystem, () => ({
				async scanLines() {
					return { ok: true, value: {
						async *[Symbol.asyncIterator]() {
							yield { ok: true as const, value: { line: 1, text: "needle", byteStart: 0, byteEnd: 6 } };
							yield { ok: false as const, error: { code: "changed-during-read" as const, message: "changed", path: "race.txt" } };
						},
						async close() { closes += 1; },
					} };
				},
			}));
			for (const [paths, explicit] of [[["."], false], [["race.txt"], true]] as const) {
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem,
					operation: opened.context,
					maxDepth: 12,
					maxEntries: 100_000,
				}));
				const scanned = await scanInventoryText(inventory, queryPlan("needle"), {
					filesystem,
					operation: opened.context,
				});
				const success = expectSuccess(scanned);
				expect(success.hits).toEqual([]);
				if (explicit) expect(success.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(success.stats.skipped).toMatchObject({ changed: 1 });
			}
			expect(closes).toBe(2);
		});
	});

	it("紧凑输出只保留位置、symbol、related 标记、声明和证据行", () => {
		const output = renderGrepSuccess({
			status: "success",
			query: "handler",
			query_mode: "regex",
			path: ".",
			total_candidates: 2,
			returned_regions: 2,
			returned_files: 2,
			approx_tokens: 0,
			stats: {
				traversed_entries: 2,
				searched_files: 2,
				searched_bytes: 100,
				text_hits: 0,
				parsed_files: 2,
				dropped_text_hits: 0,
				dropped_related_anchors: 0,
				dropped_related_results: 0,
				ast_skipped_oversized_files: 0,
			},
			truncated_by: [],
			regions: [
				{
					path: "src/features/authentication/first-handler.ts",
					start_line: 1,
					end_line: 3,
					kind: "function",
					symbol: "firstHandler",
					declaration: "function firstHandler(input: AuthInput): Session",
					query_match: "semantic",
					roles: ["definition", "defined"],
					matched_by: ["exact-symbol"],
					sources: ["text-lexical"],
					display_lines: [{ line: 2, text: "return createSession(input);", type: "evidence" }],
				},
				{
					path: "src/features/authentication/second-handler.ts",
					start_line: 5,
					end_line: 7,
					kind: "function",
					symbol: "secondHandler",
					query_match: "semantic",
					matched_by: ["related"],
					sources: [],
				},
			],
		});

		expect(output).toContain([
			"src/features/authentication/first-handler.ts:1-3 firstHandler [not match, related]",
			"  function firstHandler(input: AuthInput): Session",
			"  2: return createSession(input);",
		].join("\n"));
		expect(output).toContain("src/features/authentication/second-handler.ts:5-7 secondHandler [not match, related]");
		for (const metadata of ["kind=", "symbol=", "roles=", "matched-by=", "declaration:"]) {
			expect(output).not.toContain(metadata);
		}
	});

	it("不按输出 token 数丢弃长候选", () => {
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
			declaration: "function oversizedNeedle(): string",
			lineText: longLine.trimEnd(),
		});
		const result = packGrepResults({
			query: "needle",
			queryMode: "regex",
			path: ".",
			regions: [candidate],
			stats: {
				traversed_entries: 1,
				searched_files: 1,
				searched_bytes: Buffer.byteLength(source),
				text_hits: 80,
				parsed_files: 1,
				dropped_text_hits: 0,
				dropped_related_anchors: 0,
				ast_skipped_oversized_files: 0,
			},
			truncationReasons: [],
			resultLimit: 1,
			relatedResultLimit: 8,
			regionalDisplayLimit: 3,
		});

		expect(result.regions).toHaveLength(1);
		expect(result.truncated_by).toEqual([]);
		expect(result.approx_tokens).toBeGreaterThan(100);
	});

	it("固定区域胶囊不携带 source body", () => {
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
			declaration: "function largeNeedle()",
			lineText: "  return needle;",
		});
		const second = packCandidate({ id: "second", path: "b.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third", path: "c.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([large, second, third], { resultLimit: 3 });

		expect(result.regions.map((region) => region.path)).toEqual(["a-large.ts", "b.ts", "c.ts"]);
		expect(firstRegion(result)).toMatchObject({ match_lines: [72], display_lines: [expect.objectContaining({ text: "  return needle;" })] });
		expect(formatCompactGrepResult(result)).not.toContain("lines omitted");
		expect(formatCompactGrepResult(result)).not.toContain("padding0");
	});

	it("packer 保留 relevance head，并在同 tier 的剩余名额中减少同文件重复", () => {
		const candidates = Array.from({ length: 40 }, (_, index) => packCandidate({
			id: `candidate-${index}`,
			path: index < 8 ? "src/shared.ts" : `src/candidate-${index}.ts`,
			startLine: index + 1,
			endLine: index + 1,
			endByte: index + 1,
			matchLine: index + 1,
			symbol: `candidate${index}`,
			evidence: rankingEvidence("text-regex", index + 1),
		}));
		const result = packRegions(candidates, { resultLimit: 6 });

		expect(result.regions.slice(0, 4).map((region) => region.path)).toEqual([
			"src/shared.ts",
			"src/shared.ts",
			"src/shared.ts",
			"src/shared.ts",
		]);
		expect(result.regions.slice(4).some((region) => region.path !== "src/shared.ts")).toBe(true);
		expect(result.ranking).toMatchObject({
			algorithm: "semantic-tier-bm25f-rrf-mmr-v2",
			candidate_count: 40,
			eligible_candidate_count: 40,
			selected_candidate_count: 6,
			relevance_head_size: 4,
			tier_count: 1,
			relevance_prefix_file_count: 1,
			selected_file_count: 3,
			regions: [
				{ relevance_rank: 1, selection: "head" },
				{ relevance_rank: 2, selection: "head" },
				{ relevance_rank: 3, selection: "head" },
				{ relevance_rank: 4, selection: "head" },
				expect.objectContaining({ selection: "mmr" }),
				expect.objectContaining({ selection: "mmr" }),
			],
		});
		expect(result.ranking?.mmr_replacement_count).toBeGreaterThan(0);
		expect(result.ranking?.regions[0]?.auxiliary_score).toBeCloseTo(1 / 61);
		expect(result.truncated_by).toContain("result_limit");
		expect(formatCompactGrepResult(result)).toContain('<grep truncated="result_limit">');
	});

	it("超长 declaration 被固定截取并稳定合并截断原因", () => {
		const hugeDeclaration = `function oversized(${Array.from({ length: 400 }, (_, index) => `parameter${index}: string`).join(", ")})`;
		const oversized = packCandidate({
			id: "oversized-declaration",
			path: "a-oversized.ts",
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
			declaration: hugeDeclaration,
		});
		const second = packCandidate({ id: "second", path: "b-second.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third", path: "c-third.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([oversized, second, third], {
			resultLimit: 2,
			truncationReasons: ["entry_limit"],
		});

		expect(result.regions.map((region) => region.path)).toContain("a-oversized.ts");
		expect(firstRegion(result).declaration).toHaveLength(240);
		expect(result.truncated_by).toEqual([
			"entry_limit",
			"result_limit",
		]);
		expect(result.approx_tokens).toBe(countTextTokensSync(formatCompactGrepResult(result)).tokens);
	});

	it("所有候选只共享统一条数限制", () => {
		const candidates = Array.from({ length: 3 }, (_, index) => packCandidate({
			id: `candidate-${index}`,
			path: `candidate-${index}.ts`,
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
		}));
		const result = packRegions(candidates, { resultLimit: 1 });
		expect(result.regions).toHaveLength(1);
		expect(result.truncated_by).toContain("result_limit");
	});
});
