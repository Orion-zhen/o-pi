import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Language, Parser, Tree } from "web-tree-sitter";

import { TREE_SITTER_LANGUAGES } from "../../src/syntax-tree/grammars.js";
import { decodeShellWord } from "../../src/syntax-tree/bash.js";
import { parseSyntaxTree, SyntaxAnalysisAbortedError, SyntaxAnalysisTimeoutError } from "../../src/syntax-tree/parser.js";

const require = createRequire(import.meta.url);
const bashGrammar = TREE_SITTER_LANGUAGES.bash.grammar;
const javascriptGrammar = TREE_SITTER_LANGUAGES.javascript.grammar;
afterEach(() => vi.restoreAllMocks());

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

	it("加载 Bash WASM 而非 native 模块，文档只释放一次语法树", async () => {
		const deleted = vi.spyOn(Tree.prototype, "delete");
		const document = await parseSyntaxTree(bashGrammar, "echo ready && git push origin main > result.log");
		expect(document?.root.type).toBe("program");
		expect(document?.root.descendantsOfType("command").map((node) => node.text)).toEqual(["echo ready", "git push origin main"]);
		document?.dispose();
		document?.dispose();
		expect(deleted).toHaveBeenCalledOnce();
		expect(require.cache[require.resolve("tree-sitter-bash")]).toBeUndefined();
	});

	it("并发解析和后续解析不会改变仍存活的文档", async () => {
		const documents = await Promise.all([
			parseSyntaxTree(javascriptGrammar, "const first = 1;"),
			parseSyntaxTree(javascriptGrammar, "const second = 2;"),
			parseSyntaxTree(bashGrammar, "echo third"),
		]);
		try {
			expect(documents.map((document) => document?.root.text)).toEqual(["const first = 1;", "const second = 2;", "echo third"]);
			documents[1]?.dispose();
			expect(documents[0]?.root.text).toBe("const first = 1;");
		} finally {
			for (const document of documents) document?.dispose();
		}
	});

	it("确定的语法加载失败不重复加载", async () => {
		const load = vi.spyOn(Language, "load").mockRejectedValueOnce(new Error("invalid WASM"));
		const grammar = TREE_SITTER_LANGUAGES.tsx.grammar;
		expect(await parseSyntaxTree(grammar, "const value = 1;")).toBeUndefined();
		expect(await parseSyntaxTree(grammar, "const value = 2;")).toBeUndefined();
		expect(load).toHaveBeenCalledOnce();
	});

	it("固定 250ms 解析截止时间，超时后仍能解析其他文档", async () => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		vi.spyOn(Parser.prototype, "parse").mockImplementationOnce((_input, _oldTree, options) => {
			clock.mockReturnValue(351);
			expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
			return null;
		});
		expect(await parseSyntaxTree(javascriptGrammar, "const value = 1;")).toBeUndefined();
		const document = await parseSyntaxTree(javascriptGrammar, "const next = 2;");
		expect(document?.root.text).toBe("const next = 2;");
		document?.dispose();
	});

	it("同一截止时间和取消信号继续约束 AST 分析", async () => {
		const controller = new AbortController();
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const document = await parseSyntaxTree(javascriptGrammar, "const value = 1;", controller.signal);
		expect(document).toBeDefined();
		try {
			clock.mockReturnValue(351);
			expect(() => document?.control.check()).toThrow(SyntaxAnalysisTimeoutError);
			controller.abort();
			expect(() => document?.control.check()).toThrow(SyntaxAnalysisAbortedError);
		} finally {
			document?.dispose();
		}
	});

	it("语法加载期间的取消向上传播，不影响后续调用", async () => {
		const controller = new AbortController();
		const originalLoad = Language.load.bind(Language);
		vi.spyOn(Language, "load").mockImplementationOnce(async (...args) => {
			controller.abort();
			return originalLoad(...args);
		});
		const grammar = TREE_SITTER_LANGUAGES.c.grammar;
		await expect(parseSyntaxTree(grammar, "int first;", controller.signal)).rejects.toBeInstanceOf(SyntaxAnalysisAbortedError);
		const document = await parseSyntaxTree(grammar, "int second;");
		expect(document?.root.text).toBe("int second;");
		document?.dispose();
	});

	it("progress callback 取消后继续解析其他文档", async () => {
		const controller = new AbortController();
		vi.spyOn(Parser.prototype, "parse").mockImplementationOnce((_input, _oldTree, options) => {
			controller.abort();
			expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
			return null;
		});
		await expect(parseSyntaxTree(javascriptGrammar, "const value = 1;", controller.signal)).rejects.toBeInstanceOf(SyntaxAnalysisAbortedError);
		const document = await parseSyntaxTree(javascriptGrammar, "const next = 2;");
		expect(document?.root.text).toBe("const next = 2;");
		document?.dispose();
	});

	it("解析器异常后，并发等待者和后续调用不会取得已释放句柄", async () => {
		vi.spyOn(Parser.prototype, "parse").mockImplementationOnce(() => { throw new Error("parser exception"); });
		const deleted = vi.spyOn(Parser.prototype, "delete");
		const documents = await Promise.all([
			parseSyntaxTree(javascriptGrammar, "const first = 1;"),
			parseSyntaxTree(javascriptGrammar, "const second = 2;"),
			parseSyntaxTree(javascriptGrammar, "const third = 3;"),
		]);
		try {
			expect(documents.map((document) => document?.root.text)).toEqual([undefined, "const second = 2;", "const third = 3;"]);
			expect(deleted).toHaveBeenCalledTimes(3);
		} finally {
			for (const document of documents) document?.dispose();
		}
	});
});
