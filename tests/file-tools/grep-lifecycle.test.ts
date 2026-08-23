import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import { loadTreeSitterParser } from "../../src/syntax-tree/loader.js";
import { parseSyntaxTree } from "../../src/syntax-tree/parser.js";
import type { AnalyzeCode } from "../../src/code-index/types.js";
import { AbortGrepParse, GrepParser } from "../../src/file-tools/grep/parser-pool.js";
import { createGrepTestContext, deferredVoid, overrideContent, withGrepRuntime } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep lifecycle", () => {
	it("parser owner 支持本地、worker 和幂等 dispose", async () => {
		const parser = new GrepParser();
		const local = await parser.analyzeFile("notes.txt", "needle\n", undefined, false);
		expect(local.status).toBe("unsupported");
		const worker = await parser.analyzeFiles(
			Array.from({ length: 33 }, (_value, index) => ({ path: `module-${index}.ts`, text: `export const value${index} = ${index};\n`, syntax: true })),
			undefined,
		);
		expect(worker).toHaveLength(33);
		const shared = await loadTreeSitterParser(javascriptAdapter.grammar);
		if (shared === undefined) throw new Error("javascript parser unavailable");
		parser.dispose();
		parser.dispose();
		const retained = await loadTreeSitterParser(javascriptAdapter.grammar);
		if (retained === undefined) throw new Error("javascript parser unavailable after grep disposal");
		expect(retained).toBe(shared);
		const document = await parseSyntaxTree(javascriptAdapter.grammar, "export const retained = true;\n");
		expect(document).toBeDefined();
		document?.dispose();
		await expect(parser.analyzeFiles([], undefined)).rejects.toBeInstanceOf(AbortGrepParse);

		const pendingParser = new GrepParser();
		const pending = pendingParser.analyzeFiles(
			Array.from({ length: 64 }, (_value, index) => ({
				path: `pending-${index}.ts`,
				text: `export const pending${index} = '${"x".repeat(16 * 1024)}';\n`,
				syntax: true,
			})),
			undefined,
		);
		pendingParser.dispose();
		await expect(pending).rejects.toBeInstanceOf(AbortGrepParse);
	});

	it("grep owner dispose 幂等且停止后拒绝新调用", async () => {
		await withGrepRuntime(testContext.workspace, "grep-owner", async ({ tool, opened }) => {
			tool.dispose();
			tool.dispose();
			await expect(tool.execute({ query: "needle" }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
			})).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});

	it("grep owner dispose 取消 active code analyzer", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function Target() { return false; }\n");
		await withGrepRuntime(testContext.workspace, "grep-owner-active", async ({ tool, opened }) => {
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
			const active = tool.execute({ query: "Target" }, {
				filesystem: opened.filesystem,
				operation: {},
				limits: opened.limits,
				analyzeCode,
			});
			await started.promise;
			tool.dispose();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(analyzerAborted).toBe(true);
		});
	});

	it("regex 只执行一次稳定 line scan，不完整读取正文", async () => {
		await writeFile(path.join(testContext.workspace, "stream.txt"), `needle\n${"tail\n".repeat(200)}`);
		await withGrepRuntime(testContext.workspace, "grep-stream", async ({ tool, opened }) => {
			let fullReads = 0;
			let lineScans = 0;
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async readText(file, options) {
					fullReads += 1;
					return await content.readText(file, options);
				},
				async scanLines(file, options) {
					lineScans += 1;
					return await content.scanLines(file, options);
				},
			}));
			const result = await tool.execute({ path: ["stream.txt"], query: "needle" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			});
			expect(result).toMatchObject({ status: "success", regions: [expect.objectContaining({ path: "stream.txt" })] });
			expect({ fullReads, lineScans }).toEqual({ fullReads: 0, lineScans: 1 });
		});
	});

	it("active regex line scan 响应取消且不继续返回部分命中", async () => {
		await writeFile(path.join(testContext.workspace, "cancel.txt"), `${"line\n".repeat(20_000)}needle\n`);
		await withGrepRuntime(testContext.workspace, "grep-strict-cancel", async ({ tool, opened }) => {
			const controller = new AbortController();
			const started = deferredVoid();
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async scanLines(file, options) {
					started.resolve();
					return await content.scanLines(file, options);
				},
			}));
			const active = tool.execute({ path: ["cancel.txt"], query: "needle" }, {
				filesystem,
				operation: { signal: controller.signal },
				limits: opened.limits,
			});
			await started.promise;
			controller.abort();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		});
	});

});
