import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TREE_SITTER_LANGUAGES } from "../../src/syntax-tree/grammars.js";
import { parseSyntaxTree } from "../../src/syntax-tree/parser.js";
import type { AnalyzeCode } from "../../src/code-index/types.js";
import { AbortGrepParse, GrepParser } from "../../src/file-tools/grep/parser-pool.js";
import { deferredVoid } from "../helpers/async.js";
import { countContentReads, createGrepTestContext, overrideContent, withGrepRuntime } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep lifecycle", () => {
	it("parser owner 支持本地、worker 和幂等 dispose", async () => {
		const parser = new GrepParser();
		const [local] = await parser.analyzeFiles([{ path: "local.ts", text: "export const needle = true;\n" }], undefined);
		expect(local?.status).toBe("parsed");
		const worker = await parser.analyzeFiles(
			Array.from({ length: 33 }, (_value, index) => ({ path: `module-${index}.ts`, text: `export const value${index} = ${index};\n` })),
			undefined,
		);
		expect(worker).toHaveLength(33);
		parser.dispose();
		parser.dispose();
		const document = await parseSyntaxTree(TREE_SITTER_LANGUAGES.javascript.grammar, "export const retained = true;\n");
		expect(document).toBeDefined();
		document?.dispose();
		await expect(parser.analyzeFiles([], undefined)).rejects.toBeInstanceOf(AbortGrepParse);

		const pendingParser = new GrepParser();
		const pending = pendingParser.analyzeFiles(
			Array.from({ length: 64 }, (_value, index) => ({
				path: `pending-${index}.ts`,
				text: `export const pending${index} = '${"x".repeat(16 * 1024)}';\n`,
			})),
			undefined,
		);
		pendingParser.dispose();
		await expect(pending).rejects.toBeInstanceOf(AbortGrepParse);
	});

	it("grep owner dispose 幂等且停止后拒绝新调用", async () => {
		await withGrepRuntime(testContext.workspace, "grep-owner", async ({ tool, execute }) => {
			tool.dispose();
			tool.dispose();
			await expect(execute({ query: "needle" })).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});

	it("grep owner dispose 取消 active code analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function Target() { return false; }\n");
		await withGrepRuntime(testContext.workspace, "grep-owner-active", async ({ tool, execute }) => {
			const started = deferredVoid();
			let analyzerAborted = false;
			const analyzeCode: AnalyzeCode = async (input) => {
				started.resolve();
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => {
						analyzerAborted = true;
						reject(new Error("aborted"));
					};
					if (input.signal?.aborted === true) onAbort();
					else input.signal?.addEventListener("abort", onAbort, { once: true });
				});
				return undefined;
			};
			const active = execute({ query: "Target" }, { operation: {}, analyzeCode });
			await started.promise;
			tool.dispose();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(analyzerAborted).toBe(true);
		});
	});

	it("regex 只执行一次稳定 line scan，不完整读取正文", async () => {
		await writeFile(path.join(testContext.workspace, "stream.txt"), `needle\n${"tail\n".repeat(200)}`);
		await withGrepRuntime(testContext.workspace, "grep-stream", async ({ execute, opened }) => {
			const { counts, filesystem } = countContentReads(opened.filesystem);
			const result = await execute({ path: ["stream.txt"], query: "needle" }, { filesystem });
			expect(result).toMatchObject({ status: "success", regions: [expect.objectContaining({ path: "stream.txt" })] });
			expect(counts).toEqual({ fullReads: 0, lineScans: 1 });
		});
	});

	it("active regex line scan 响应取消且不继续返回部分命中", async () => {
		await writeFile(path.join(testContext.workspace, "cancel.txt"), `${"line\n".repeat(20_000)}needle\n`);
		await withGrepRuntime(testContext.workspace, "grep-strict-cancel", async ({ execute, opened }) => {
			const controller = new AbortController();
			const started = deferredVoid();
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async scanLines(file, options) {
					started.resolve();
					return await content.scanLines(file, options);
				},
			}));
			const active = execute(
				{ path: ["cancel.txt"], query: "needle" },
				{ filesystem, operation: { signal: controller.signal } },
			);
			await started.promise;
			controller.abort();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});

});
