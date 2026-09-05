import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import { getTreeSitterLanguage } from "../../src/syntax-tree/grammars.js";
import { decodeShellWord } from "../../src/syntax-tree/bash.js";
import { loadTreeSitterParser } from "../../src/syntax-tree/loader.js";
import { parseSyntaxTree, SyntaxAnalysisAbortedError } from "../../src/syntax-tree/parser.js";

const require = createRequire(import.meta.url);
const bashGrammar = getTreeSitterLanguage("bash").grammar;
const javascriptGrammar = getTreeSitterLanguage("javascript").grammar;

describe("shared syntax tree parser", () => {
	it.each([
		["pu\\\nsh", "push"],
		['"pu\\\nsh"', "push"],
		["'pu\\\nsh'", "pu\\\nsh"],
		["'中文 $HOME'", "中文 $HOME"],
		['"a\\qb"', "a\\qb"],
		['"a\\$b"', "a$b"],
		["a\\ b", "a b"],
		["$HOME", undefined],
		['"$HOME"', undefined],
		["`command`", undefined],
		["*.ts", undefined],
		["~/file", undefined],
		["{a,b}", undefined],
		["trailing\\", undefined],
		["'unterminated", undefined],
	] as const)("共享 Shell 解码保留引号和转义语义: %s", (source, expected) => {
		expect(decodeShellWord(source)).toBe(expected);
	});

	it("动态解码复用同一引号规则，并由调用方决定是否允许未引用展开", () => {
		const resolveExpansion = (_source: string, start: number) => ({ value: "目录", end: start + 1 });
		expect(decodeShellWord('"$x/file"', { resolveExpansion })).toBe("目录/file");
		expect(decodeShellWord("$x/file", { resolveExpansion })).toBeUndefined();
		expect(decodeShellWord("$x/*.ts", { resolveExpansion, allowUnquotedExpansion: true, allowGlob: true })).toBe("目录/*.ts");
	});

	it("通过统一 grammar catalog 加载 Bash WASM，不加载 native module", async () => {
		const document = await parseSyntaxTree(
			bashGrammar,
			"echo ready && git push origin main > result.log",
		);
		expect(document?.root.type).toBe("program");
		expect(document?.root.descendantsOfType("command").map((node) => node.text)).toEqual([
			"echo ready",
			"git push origin main",
		]);
		document?.dispose();
		document?.dispose();
		expect(require.cache[require.resolve("tree-sitter-bash")]).toBeUndefined();
	});

	it("不同 grammar 共用 loader，并分别缓存 parser", async () => {
		const bashFirst = await loadTreeSitterParser(bashGrammar);
		const bashSecond = await loadTreeSitterParser(bashGrammar);
		const javascript = await loadTreeSitterParser(javascriptGrammar);
		if (bashFirst === undefined || bashSecond === undefined || javascript === undefined) {
			throw new Error("Tree-sitter parser unavailable");
		}
		expect(bashSecond).toBe(bashFirst);
		expect(javascript).not.toBe(bashFirst);
	});

	it("grammar 加载失败后永久复用 undefined 结果", async () => {
		const missingGrammar = { packageName: "tree-sitter-typescript", wasmFile: "missing.wasm" };
		const first = loadTreeSitterParser(missingGrammar);
		expect(loadTreeSitterParser(missingGrammar)).toBe(first);
		expect(await first).toBeUndefined();

		const second = loadTreeSitterParser(missingGrammar);
		expect(second).toBe(first);
		expect(await second).toBeUndefined();
	});

	it("固定 250ms deadline 超时后 reset parser", async () => {
		const parser = await loadTreeSitterParser(javascriptGrammar);
		if (parser === undefined) throw new Error("javascript parser unavailable");
		let now = 100;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		const parseSpy = vi.spyOn(parser, "parse").mockImplementation((_input, _oldTree, options) => {
			now = 351;
			expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
			return null;
		});
		try {
			expect(await parseSyntaxTree(javascriptGrammar, "const value = 1;\n")).toBeUndefined();
		} finally {
			parseSpy.mockRestore();
			clock.mockRestore();
		}
	});

	it("取消会向上抛出，并且 progress callback 取消后 parser 仍可复用", async () => {
		const parser = await loadTreeSitterParser(javascriptGrammar);
		if (parser === undefined) throw new Error("javascript parser unavailable");
		const controller = new AbortController();
		const originalParse = parser.parse.bind(parser);
		const parseSpy = vi.spyOn(parser, "parse")
			.mockImplementationOnce((_input, _oldTree, options) => {
				controller.abort();
				expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
				return null;
			})
			.mockImplementation(originalParse);
		try {
			await expect(parseSyntaxTree(javascriptGrammar, "const value = 1;\n", { signal: controller.signal }))
				.rejects.toBeInstanceOf(SyntaxAnalysisAbortedError);
			const document = await parseSyntaxTree(javascriptGrammar, "const value = 1;\n");
			expect(document).toBeDefined();
			document?.dispose();
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("parser 异常后替换失效 parser 并恢复解析", async () => {
		const parser = await loadTreeSitterParser(javascriptGrammar);
		if (parser === undefined) throw new Error("javascript parser unavailable");
		const originalParse = parser.parse.bind(parser);
		const parseSpy = vi.spyOn(parser, "parse")
			.mockImplementationOnce(() => { throw new Error("simulated parser exception"); })
			.mockImplementation(originalParse);
		try {
			expect(await parseSyntaxTree(javascriptGrammar, "function value() { return 1; }\n")).toBeUndefined();
			const replacement = await loadTreeSitterParser(javascriptGrammar);
			expect(replacement).toBeDefined();
			expect(replacement).not.toBe(parser);
			const document = await parseSyntaxTree(javascriptGrammar, "function value() { return 1; }\n");
			expect(document).toBeDefined();
			document?.dispose();
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("创建文档失败时释放 syntax tree，并替换 parser", async () => {
		const parser = await loadTreeSitterParser(javascriptGrammar);
		if (parser === undefined) throw new Error("javascript parser unavailable");
		const originalParse = parser.parse.bind(parser);
		let deleted = false;
		const parseSpy = vi.spyOn(parser, "parse").mockImplementation((...args) => {
			const tree = originalParse(...args);
			if (tree === null) throw new Error("tree unavailable");
			const originalDelete = tree.delete.bind(tree);
			vi.spyOn(tree, "delete").mockImplementation(() => {
				deleted = true;
				originalDelete();
			});
			vi.spyOn(tree, "rootNode", "get").mockImplementation(() => { throw new Error("simulated root failure"); });
			return tree;
		});
		try {
			expect(await parseSyntaxTree(javascriptGrammar, "const value = 1;\n")).toBeUndefined();
			expect(deleted).toBe(true);
			const replacement = await loadTreeSitterParser(javascriptGrammar);
			expect(replacement).toBeDefined();
			expect(replacement).not.toBe(parser);
		} finally {
			parseSpy.mockRestore();
		}
	});
});
