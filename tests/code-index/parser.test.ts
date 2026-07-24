import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileIdentity, createSymbolId } from "../../src/code-index/identity.js";
import { analyzeCodeFile, byteRangeForLines, countTextTokenMatches, parseCodeUnits, splitTokens, tokenizeText } from "../../src/code-index/parser.js";
import { loadTreeSitterRuntime } from "../../src/code-index/tree-sitter-loader.js";

const require = createRequire(import.meta.url);
const treeSitterModules = {
	runtime: require.resolve("tree-sitter"),
	javascript: require.resolve("tree-sitter-javascript"),
	typescript: require.resolve("tree-sitter-typescript"),
	python: require.resolve("tree-sitter-python"),
	go: require.resolve("tree-sitter-go"),
	rust: require.resolve("tree-sitter-rust"),
	c: require.resolve("tree-sitter-c"),
	cpp: require.resolve("tree-sitter-cpp"),
};

afterEach(() => {
	vi.useRealTimers();
	vi.doUnmock("../../src/code-index/tree-sitter-loader.js");
});

function symbols(filePath: string, text: string): Array<[string, string | undefined, string | undefined]> {
	return parseCodeUnits(filePath, text).units.map((unit) => [unit.kind, unit.name, unit.qualifiedName]);
}

describe("shared code parser", () => {
	it("导入 parser、grep 和注册 extension 时不加载 grammar，首次解析仅加载对应 grammar 并复用 runtime", async () => {
		for (const modulePath of Object.values(treeSitterModules)) expect(require.cache[modulePath]).toBeUndefined();

		await import("../../src/file-tools/tools/grep.js");
		const { default: fileTools } = await import("../../agent/extensions/file-tools.js");
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		fileTools({
			registerTool() {},
			on(name: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);
		expect(handlers.has("before_agent_start")).toBe(false);

		parseCodeUnits("notes.txt", "plain text");
		for (const modulePath of Object.values(treeSitterModules)) expect(require.cache[modulePath]).toBeUndefined();

		parseCodeUnits("first.ts", "export function first() {}\n");
		expect(require.cache[treeSitterModules.runtime]).toBeDefined();
		expect(require.cache[treeSitterModules.typescript]).toBeDefined();
		expect(require.cache[treeSitterModules.javascript]).toBeUndefined();
		expect(require.cache[treeSitterModules.python]).toBeUndefined();
		expect(require.cache[treeSitterModules.go]).toBeUndefined();
		expect(require.cache[treeSitterModules.rust]).toBeUndefined();
		expect(require.cache[treeSitterModules.c]).toBeUndefined();
		expect(require.cache[treeSitterModules.cpp]).toBeUndefined();
		expect(loadTreeSitterRuntime("typescript")).toBe(loadTreeSitterRuntime("typescript"));
		await expect(Promise.resolve(handlers.get("session_shutdown")?.())).resolves.toBeUndefined();
		expect(require.cache[treeSitterModules.javascript]).toBeUndefined();
		expect(require.cache[treeSitterModules.python]).toBeUndefined();
		expect(require.cache[treeSitterModules.go]).toBeUndefined();
		expect(require.cache[treeSitterModules.rust]).toBeUndefined();
		expect(require.cache[treeSitterModules.c]).toBeUndefined();
		expect(require.cache[treeSitterModules.cpp]).toBeUndefined();
	});

	it("提取 C/C++ symbol、文件级 include 和 UTF-8 byte range", () => {
		const c = analyzeCodeFile("src/point.c", "// 你😀\n#include <stdio.h>\nint add(int value) { return value; }\n");
		expect(c).toMatchObject({ status: "parsed", index: { language: "c" } });
		expect(c.index.units.map((unit) => [unit.kind, unit.qualifiedName])).toEqual([["function", "add"]]);
		expect(c.imports).toEqual([expect.objectContaining({ specifier: "stdio.h", startLine: 2, endLine: 2 })]);
		expect(c.imports[0]?.startByte).toBe(Buffer.byteLength("// 你😀\n#include <", "utf8"));

		const cpp = analyzeCodeFile("include/api.H", "namespace api { class Client { public: void run() {} }; }\n");
		expect(cpp).toMatchObject({ status: "parsed", index: { language: "cpp" } });
		expect(cpp.index.units.map((unit) => [unit.kind, unit.qualifiedName])).toEqual([
			["namespace", "api"],
			["class", "api.Client"],
			["method", "api.Client.run"],
		]);
	});

	it("提取 TypeScript、JavaScript、Python、Go 和 Rust symbol，并保留 class method scope", () => {
		expect(symbols("auth.ts", "export class AuthService {\n  async login() { return issueToken(); }\n}\nexport const makeSession = () => null;\n")).toEqual([
			["class", "AuthService", "AuthService"],
			["method", "login", "AuthService.login"],
			["declaration", "makeSession", "makeSession"],
		]);
		expect(symbols("auth.js", "class AuthService { login() { return true; } }\nfunction top() {}\n")).toEqual([
			["class", "AuthService", "AuthService"],
			["method", "login", "AuthService.login"],
			["function", "top", "top"],
		]);
		expect(symbols("worker.py", "class Worker:\n  def run(self):\n    pass\ndef top():\n  pass\n")).toEqual([
			["class", "Worker", "Worker"],
			["function", "run", "Worker.run"],
			["function", "top", "top"],
		]);
		expect(symbols("server.go", "package main\ntype Server struct{}\nfunc Start() {}\nfunc (s Server) Stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["function", "Start", "Start"],
			["function", "Stop", "Stop"],
		]);
		expect(symbols("server.rs", "pub struct Server;\nimpl Server { pub fn start(&self) {} }\npub fn stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["module", "Server", "Server"],
			["function", "start", "Server.start"],
			["function", "stop", "stop"],
		]);
	});

	it("函数内部局部声明不拆分为独立 region", () => {
		const parsed = parseCodeUnits("a.ts", "export function demo() {\n  const Token = 'Token';\n  return Token;\n}\n");
		expect(parsed.units.map((unit) => unit.qualifiedName)).toEqual(["demo"]);
	});

	it("unsupported language 返回 text 空索引，且 file identity 使用规范化内部路径", () => {
		expect(parseCodeUnits("./docs\\notes.conf", "section=true\n")).toEqual({
			id: "file:docs/notes.conf",
			path: "docs/notes.conf",
			language: "text",
			units: [],
			symbols: [],
		});
		expect(createFileIdentity("./src/feature/../auth.ts")).toEqual({ id: "file:src/auth.ts", path: "src/auth.ts" });
	});

	it.each([
		["a.ts", "import { x } from './x';\n", "./x"],
		["a.jsx", "const x = require('./x');\n", "./x"],
		["a.py", "from app.worker import run\n", "app.worker"],
		["a.go", "package a\nimport \"example/x\"\n", "example/x"],
		["a.rs", "use crate::worker::run;\n", "crate::worker::run"],
	])("详细分析保留 %s 的文件级 import", (filePath, text, specifier) => {
		const analyzed = analyzeCodeFile(filePath, text);
		expect(analyzed.status).toBe("parsed");
		expect(analyzed.imports).toEqual([expect.objectContaining({ specifier })]);
	});

	it("提取 dynamic import 和 Go import block，且不把普通 Go 字符串当作 import", () => {
		expect(analyzeCodeFile("a.ts", "const lazy = import('./lazy');\n").imports.map((item) => item.specifier)).toEqual(["./lazy"]);
		const go = analyzeCodeFile("a.go", "package a\nimport (\n  \"example/one\"\n  alias \"example/two\"\n)\nvar text = \"not/import\"\n");
		expect(go.imports.map((item) => item.specifier)).toEqual(["example/one", "example/two"]);
	});

	it("SourceRange 使用 UTF-8 byte offset、1-based inclusive line 和半开字节区间", () => {
		const text = "// 你😀\nexport function demo() {\n  return '好';\n}\n";
		const unit = parseCodeUnits("utf8.ts", text).units[0];
		if (unit === undefined) throw new Error("missing parsed unit");
		expect(unit).toMatchObject({ startLine: 2, endLine: 4, startByte: Buffer.byteLength("// 你😀\n", "utf8") });
		expect(Buffer.from(text, "utf8").subarray(unit.startByte, unit.endByte).toString("utf8")).toBe("export function demo() {\n  return '好';\n}");
		expect(byteRangeForLines(text, 2, 3)).toEqual({
			startLine: 2,
			endLine: 3,
			startByte: Buffer.byteLength("// 你😀\n", "utf8"),
			endByte: Buffer.byteLength("// 你😀\nexport function demo() {\n  return '好';\n", "utf8"),
		});
	});

	it.each([
		["createRetryableLoader retries module_load", ["create", "retryable", "loader", "module", "load"]],
		["HTTPServer handles retry-count 2", ["http", "server", "retry-count", "retry", "count", "2"]],
	])("目标 token 计数与完整 token map 等价: %s", (text, queryTokens) => {
		const normalized = splitTokens(queryTokens.join(" ")).map((token) => token.toLocaleLowerCase());
		const complete = tokenizeText(text);
		expect(countTextTokenMatches(text, normalized)).toBe(normalized.filter((token) => complete.has(token)).length);
	});

	it("symbol ID 由 file、kind、qualified name 和 start byte 决定，同名位置可区分且不依赖 end byte", () => {
		const input = { fileId: "file:src/a.ts", kind: "function", qualifiedName: "demo", startByte: 12 };
		expect(createSymbolId(input)).toBe("symbol:file%3Asrc%2Fa.ts:function:demo:12");
		expect(createSymbolId(input)).toBe(createSymbolId({ ...input }));
		expect(createSymbolId({ ...input, startByte: 48 })).not.toBe(createSymbolId(input));

		const short = parseCodeUnits("a.ts", "export function demo() {}\n").units[0];
		const long = parseCodeUnits("a.ts", "export function demo() { return 1; }\n").units[0];
		expect(short?.id).toBe(long?.id);
	});

	it("runtime 或 grammar 失败时安全降级为空代码单元", async () => {
		vi.resetModules();
		vi.doMock("../../src/code-index/tree-sitter-loader.js", () => ({
			loadTreeSitterRuntime() {
				throw new Error("simulated grammar failure");
			},
		}));
		const { analyzeCodeFile: analyzeWithFailure, parseCodeUnits: parseWithFailure } = await import("../../src/code-index/parser.js");
		expect(parseWithFailure("broken.ts", "export function demo() {}\n")).toMatchObject({ language: "typescript", units: [] });
		expect(analyzeWithFailure("broken.ts", "export function demo() {}\n").status).toBe("error");
		expect(parseWithFailure("broken.c", "int demo(void) {}\n")).toMatchObject({ language: "c", units: [] });
		expect(analyzeWithFailure("broken.c", "int demo(void) {}\n").status).toBe("error");
	});
});
