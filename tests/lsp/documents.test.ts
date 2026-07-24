import { describe, expect, it } from "vitest";

import { incrementalContentChange, languageIdForServerPath, LspDocuments } from "../../src/lsp/documents.js";
import type { LspServerConfig } from "../../src/lsp/types.js";

const server: LspServerConfig = {
	id: "test",
	enabled: true,
	transport: { type: "stdio", command: "test", args: [] },
	language_ids: {
		".ts": "mapped-ts",
		".tsx": "mapped-tsx",
	},
	language_id: "fallback",
	extensions: [".ts", ".tsx", ".js"],
};

const inferredServer: LspServerConfig = {
	id: "inferred",
	enabled: true,
	transport: { type: "stdio", command: "test", args: [] },
	language_ids: {},
	extensions: [".ts", ".tsx", ".js", ".jsx"],
};

describe("lsp documents", () => {
	it.each([
		["a.ts", "mapped-ts"],
		["a.TSX", "mapped-tsx"],
		["a.js", "fallback"],
	])("按 extension map -> singular fallback 选择 %s", (filePath, expected) => {
		expect(languageIdForServerPath(server, filePath)).toBe(expected);
	});

	it.each([
		["a.ts", "typescript"],
		["a.tsx", "typescriptreact"],
		["a.js", "javascript"],
		["a.jsx", "javascriptreact"],
	])("没有配置 fallback 时按路径推断 %s", (filePath, expected) => {
		expect(languageIdForServerPath(inferredServer, filePath)).toBe(expected);
	});

	it.each([
		[
			"const 😀x = 1;\r\nnext\r\n",
			"const 😀x = 2;\r\nnext\r\n",
			{ range: { start: { line: 0, character: 12 }, end: { line: 0, character: 13 } }, text: "2" },
		],
		[
			"a\r\nb",
			"a\rb",
			{ range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } }, text: "\r" },
		],
		[
			"😀tail",
			"😀new tail",
			{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, text: "new " },
		],
	] as const)("生成 UTF-16/CRLF 最小增量 %#", (previous, next, expected) => {
		expect(incrementalContentChange(previous, next)).toEqual(expected);
	});

	it("同 URI queue 严格串行且失败不阻塞后续操作", async () => {
		const documents = new LspDocuments(4);
		const events: string[] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = documents.enqueue("file:///a.ts", async () => {
			events.push("first:start");
			await gate;
			events.push("first:end");
			throw new Error("first failed");
		});
		const second = documents.enqueue("file:///a.ts", async () => {
			events.push("second");
			return 2;
		});

		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		release();
		await expect(first).rejects.toThrow("first failed");
		await expect(second).resolves.toBe(2);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});
});
