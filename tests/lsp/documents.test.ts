import { describe, expect, it } from "vitest";

import { incrementalContentChange, LspDocuments } from "../../src/lsp/documents.js";

describe("lsp documents", () => {
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
