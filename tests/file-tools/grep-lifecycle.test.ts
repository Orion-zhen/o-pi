import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import { loadTreeSitterParser } from "../../src/code-index/tree-sitter-loader.js";
import { parseDocumentForAdapter } from "../../src/code-index/syntax-tree.js";
import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { AbortGrepParse, GrepParser } from "../../src/file-tools/grep/parser-pool.js";
import type { GrepHintSource } from "../../src/file-tools/grep/ports.js";
import { GrepTool } from "../../src/file-tools/grep/command.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { createGrepTestContext, deferredVoid } from "./grep-fixtures.js";

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
		const shared = await loadTreeSitterParser(javascriptAdapter);
		if (!("parser" in shared)) throw new Error("javascript parser unavailable");
		parser.dispose();
		parser.dispose();
		const retained = await loadTreeSitterParser(javascriptAdapter);
		if (!("parser" in retained)) throw new Error("javascript parser unavailable after grep disposal");
		expect(retained.parser).toBe(shared.parser);
		const document = await parseDocumentForAdapter(javascriptAdapter, "export const retained = true;\n");
		expect(document.document).toBeDefined();
		document.document?.dispose();
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
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-owner" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			tool.dispose();
			tool.dispose();
			await expect(tool.execute({ query: "needle" }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
			})).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("grep owner dispose 取消本地搜索后的 active LSP hint", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function Target() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function Target() { return false; }\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-owner-active" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const started = deferredVoid();
		let hintAborted = false;
		const lspHints: GrepHintSource = {
			async query(input) {
				started.resolve();
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => {
						hintAborted = true;
						reject(new Error("aborted"));
					};
					if (input.signal?.aborted === true) onAbort();
					else input.signal?.addEventListener("abort", onAbort, { once: true });
				});
				return [];
			},
		};
		try {
			const active = tool.execute({ query: "Target" }, {
				filesystem: opened.filesystem,
				operation: {},
				limits: opened.limits,
				lspHints,
			});
			await started.promise;
			tool.dispose();
			await expect(active).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
				expect(hintAborted).toBe(true);
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("regex 只执行一次稳定 line scan，不完整读取正文", async () => {
		await writeFile(path.join(testContext.workspace, "stream.txt"), `needle\n${"tail\n".repeat(200)}`);
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-stream" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let fullReads = 0;
		let lineScans = 0;
		const original = opened.filesystem.content;
		const content: ContentOperations = {
			readBytes: original.readBytes.bind(original),
			async readText(file, options, context) {
				fullReads += 1;
				return await original.readText(file, options, context);
			},
			decodeText: original.decodeText.bind(original),
			sliceText: original.sliceText.bind(original),
			async scanLines(file, options, context) {
				lineScans += 1;
				return await original.scanLines(file, options, context);
			},
		};
		const filesystem: WorkspaceFileSystem = { ...opened.filesystem, content };
		try {
			const result = await tool.execute({ path: ["stream.txt"], query: "needle" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			});
			expect(result).toMatchObject({ status: "success", regions: [expect.objectContaining({ path: "stream.txt" })] });
			expect({ fullReads, lineScans }).toEqual({ fullReads: 0, lineScans: 1 });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("active regex line scan 响应取消且不继续返回部分命中", async () => {
		await writeFile(path.join(testContext.workspace, "cancel.txt"), `${"line\n".repeat(20_000)}needle\n`);
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-strict-cancel" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const controller = new AbortController();
		const started = deferredVoid();
		const original = opened.filesystem.content;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: original.readBytes.bind(original),
				readText: original.readText.bind(original),
				decodeText: original.decodeText.bind(original),
				sliceText: original.sliceText.bind(original),
				async scanLines(file, options, context) {
					started.resolve();
					return await original.scanLines(file, options, context);
				},
			},
		};
		try {
			const active = tool.execute({ path: ["cancel.txt"], query: "needle" }, {
				filesystem,
				operation: { signal: controller.signal },
				limits: opened.limits,
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

});
