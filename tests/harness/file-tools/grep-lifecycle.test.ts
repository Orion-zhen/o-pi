import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AnalyzeCode } from "../../../src/harness/code-index/types.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { countContentReads, createGrepTestContext, expectGrepSuccess, overrideContent, withGrepRuntime } from "./grep-fixtures.ts";

const testContext = createGrepTestContext();

async function largeCodeFile(): Promise<void> {
	await writeFile(path.join(testContext.workspace, "large.ts"), "export function WorkerTarget() { return true; }\n//" + "x".repeat(256 * 1024));
}

describe("grep lifecycle", () => {
	it("可选分析取消后，worker 仍为各文件返回正确的基础结构", async () => {
		await largeCodeFile();
		await writeFile(path.join(testContext.workspace, "other.ts"), "export function WorkerOther() {}\n");
		await withGrepRuntime(testContext.workspace, "grep-analysis-deadline", async ({ execute, opened }) => {
			const analyzeCode: AnalyzeCode = async (input) => {
				const document = await input.load("large.ts");
				if (document === undefined) throw new Error("missing document");
				const deadline = new AbortController();
				const pending = input.syntax(document, deadline.signal);
				void pending.catch(() => undefined);
				deadline.abort();
				return undefined;
			};
			const result = expectGrepSuccess(await execute({ query: "Worker" }, {
				analyzeCode, limits: { ...opened.limits, grep_ast_max_file_bytes: 300_000 },
			}));
			expect(result.regions).toHaveLength(2);
			expect(result.regions).toEqual(expect.arrayContaining([
				expect.objectContaining({ path: "large.ts", kind: "function", symbol: "WorkerTarget", match_lines: [1] }),
				expect.objectContaining({ path: "other.ts", kind: "function", symbol: "WorkerOther", match_lines: [1] }),
			]));
		});
	});

	it("关闭 grep 取消活动解析，重复关闭安全且拒绝新调用", async () => {
		await largeCodeFile();
		await withGrepRuntime(testContext.workspace, "grep-owner-active", async ({ tool, execute, opened }) => {
			const started = deferredVoid();
			const analyzeCode: AnalyzeCode = async (input) => {
				const document = await input.load("large.ts");
				if (document === undefined) throw new Error("missing document");
				const pending = input.syntax(document, input.signal);
				started.resolve();
				await pending;
				return undefined;
			};
			const active = execute({ query: "WorkerTarget" }, {
				analyzeCode, limits: { ...opened.limits, grep_ast_max_file_bytes: 300_000 },
			});
			await started.promise;
			tool.dispose();
			tool.dispose();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			await expect(execute({ query: "WorkerTarget" })).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});

	it("多文件正则搜索可取消，取消后仍能执行后向引用查询", async () => {
		await Promise.all(["a", "b", "c", "d"].map((name) =>
			writeFile(path.join(testContext.workspace, `${name}.txt`), `${"a".repeat(40)}!\n`)));

		await withGrepRuntime(testContext.workspace, "grep-regex-cancel", async ({ execute }) => {
			const controller = new AbortController();
			const pending = execute({ query: "^(a+)+$" }, { operation: { signal: controller.signal } });
			const timer = setTimeout(() => controller.abort(), 100);
			try {
				await expect(pending).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			} finally { clearTimeout(timer); }
			await writeFile(path.join(testContext.workspace, "regex-cancel.txt"), "word word\nword other\n");
			await expect(execute({ path: ["regex-cancel.txt"], query: "(?<term>word) \\k<term>" }))
				.resolves.toMatchObject({ status: "success", returned_regions: 1 });
		});
	});

	it("普通文本只执行流式扫描，不完整读取正文", async () => {
		await writeFile(path.join(testContext.workspace, "stream.txt"), `needle\n${"tail\n".repeat(200)}`);
		await withGrepRuntime(testContext.workspace, "grep-stream", async ({ execute, opened }) => {
			const { counts, filesystem } = countContentReads(opened.filesystem);
			const result = await execute({ path: ["stream.txt"], query: "needle" }, { filesystem });
			expect(result).toMatchObject({ status: "success", regions: [expect.objectContaining({ path: "stream.txt" })] });
			expect(counts).toEqual({ fullReads: 0, lineScans: 1 });
		});
	});

	it("流式扫描取消后不返回部分命中", async () => {
		await writeFile(path.join(testContext.workspace, "cancel.txt"), `${"line\n".repeat(20_000)}needle\n`);
		await withGrepRuntime(testContext.workspace, "grep-strict-cancel", async ({ execute, opened }) => {
			const controller = new AbortController();
			const started = deferredVoid();
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async scanLines(file, options) {
					started.resolve();
					return content.scanLines(file, options);
				},
			}));
			const active = execute({ path: ["cancel.txt"], query: "needle" }, { filesystem, operation: { signal: controller.signal } });
			await started.promise;
			controller.abort();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});
});
