import { describe, expect, it } from "vitest";

import { incrementalContentChange } from "../../src/lsp/client/text-change.js";

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
});
