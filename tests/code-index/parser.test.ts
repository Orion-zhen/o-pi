import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileIdentity, createSymbolId } from "../../src/code-index/identity.js";
import { analyzeCodeFile, buildLineIndex, byteRangeForLines, countTextTokenMatches, parseCodeUnits, splitTokens, tokenizeText } from "../../src/code-index/parser.js";
import { loadTreeSitterRuntime } from "../../src/code-index/tree-sitter-loader.js";
import { optionalDependencyPath, treeSitterAvailable } from "../helpers/optional-dependencies.js";

const require = createRequire(import.meta.url);
const treeSitterModules = {
	runtime: optionalDependencyPath("tree-sitter") ?? "",
	javascript: optionalDependencyPath("tree-sitter-javascript") ?? "",
	typescript: optionalDependencyPath("tree-sitter-typescript") ?? "",
	python: optionalDependencyPath("tree-sitter-python") ?? "",
	go: optionalDependencyPath("tree-sitter-go") ?? "",
	rust: optionalDependencyPath("tree-sitter-rust") ?? "",
	c: optionalDependencyPath("tree-sitter-c") ?? "",
	cpp: optionalDependencyPath("tree-sitter-cpp") ?? "",
};

afterEach(() => {
	vi.useRealTimers();
	vi.doUnmock("../../src/code-index/tree-sitter-loader.js");
});

function symbols(filePath: string, text: string): Array<[string, string | undefined, string | undefined]> {
	return parseCodeUnits(filePath, text).units.map((unit) => [unit.kind, unit.name, unit.qualifiedName]);
}

describe.skipIf(!treeSitterAvailable())("shared code parser", () => {
	it.each([
		{ text: "", offsets: [0], bytes: [0] },
		{ text: "abc", offsets: [0, 1, 3], bytes: [0, 1, 3] },
		{ text: "é", offsets: [0, 1], bytes: [0, 2] },
		{ text: "你😀", offsets: [0, 1, 2, 3], bytes: [0, 3, 7, 7] },
		{ text: "a\n你😀\nb", offsets: [0, 1, 2, 3, 4, 5, 6, 7], bytes: [0, 1, 2, 5, 9, 9, 10, 11] },
	])("SourceIndex 将 UTF-16 边界转换为 UTF-8 byte: $text", ({ text, offsets, bytes }) => {
		const index = buildLineIndex(text);
		expect(index.byteLength).toBe(Buffer.byteLength(text, "utf8"));
		for (const [position, expected] of offsets.map((offset, index) => [offset, bytes[index]] as const)) {
			expect(index.byteForChar(position)).toBe(expected);
		}
		expect(index.byteForChar(text.length)).toBe(index.byteLength);
	});

	it("SourceIndex 保留多行、EOF 和半开范围边界", () => {
		const text = "first\n你😀\n";
		const index = buildLineIndex(text);
		expect(index.lineStarts).toEqual([0, 6, 14]);
		expect(index.lineStartChars).toEqual([0, 6, 10]);
		expect(index.range(6, 10)).toEqual({ startLine: 2, endLine: 2, startByte: 6, endByte: 14 });
		expect(index.range(text.length, text.length)).toEqual({ startLine: 3, endLine: 3, startByte: 14, endByte: 14 });
	});

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

	it("dense ASCII units use exact source slices", () => {
		const text = Array.from({ length: 64 }, (_, index) => `function item${index}() { return ${index}; }`).join("\n");
		const units = parseCodeUnits("dense.ts", text).units;
		expect(units).toHaveLength(64);
		for (const [index, unit] of units.entries()) {
			expect(unit.name).toBe(`item${index}`);
			expect(text.slice(unit.startByte, unit.endByte)).toBe(`function item${index}() { return ${index}; }`);
		}
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
			["method", "Stop", "Server.Stop"],
		]);
		expect(symbols("server.rs", "pub struct Server;\nimpl Server { pub fn start(&self) {} }\npub fn stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["module", "Server", "Server"],
			["function", "start", "Server.start"],
			["function", "stop", "stop"],
		]);
	});

	it.each([
		["caller.js", "function caller() { target(); obj.run(); const text = 'fake()'; /* ignored() */ return Value; }", "obj.run"],
		["caller.jsx", "function caller() { target(); obj.run(); const text = 'fake()'; /* ignored() */ return Value; }", "obj.run"],
		["caller.ts", "function caller() { target(); obj.run(); const text = 'fake()'; /* ignored() */ return Value; }", "obj.run"],
		["caller.tsx", "function caller() { target(); obj.run(); const text = 'fake()'; /* ignored() */ return Value; }", "obj.run"],
		["caller.py", "def caller():\n  target()\n  obj.run()\n  text = 'fake()'\n  # ignored()\n  return Value\n", "obj.run"],
		["caller.go", "package p\nfunc caller() { target(); obj.Run(); text := \"fake()\"; _ = text; _ = Value /* ignored() */ }\n", "obj.Run"],
		["caller.rs", "fn caller() { target(); obj.run(); let text = \"fake()\"; let _ = Value; /* ignored() */ }\n", "obj.run"],
		["caller.c", "int caller(void) { target(); obj.run(); const char *text = \"fake()\"; return Value; /* ignored() */ }\n", "obj.run"],
		["caller.cpp", "int caller() { target(); obj.run(); const char *text = \"fake()\"; return Value; /* ignored() */ }\n", "obj.run"],
	])("从 %s AST 提取调用和引用，忽略字符串与注释", (filePath, text, memberCall) => {
		const unit = parseCodeUnits(filePath, text).units.find((candidate) => candidate.name === "caller");
		if (unit === undefined) throw new Error(`missing caller unit for ${filePath}`);
		expect(unit.calls).toEqual(["target", memberCall]);
		expect(unit.references).toContain("Value");
		expect(unit.references).not.toEqual(expect.arrayContaining(["caller", "fake", "ignored"]));
	});

	it("动态外层调用仍保留可静态识别的内层调用", () => {
		const unit = parseCodeUnits("nested-call.ts", "function caller() { return factory()(); }\n").units[0];
		expect(unit?.calls).toEqual(["factory"]);
	});

	it("函数内部局部声明不拆分为独立 region", () => {
		const parsed = parseCodeUnits("a.ts", "export function demo() {\n  const Token = 'Token';\n  return Token;\n}\n");
		expect(parsed.units.map((unit) => unit.qualifiedName)).toEqual(["demo"]);
	});

	it.each([
		{
			filePath: "interface.ts",
			text: "interface Service { run(): void; }\n",
			expected: ["interface:Service", "method:Service.run"],
		},
		{
			filePath: "nested.py",
			text: "class Outer:\n  class Inner:\n    def run(self):\n      pass\n",
			expected: ["class:Outer", "class:Outer.Inner", "function:Outer.Inner.run"],
		},
		{
			filePath: "modules.rs",
			text: "mod outer { fn run() {} mod inner { fn work() {} } }\n",
			expected: ["module:outer", "function:outer.run", "module:outer.inner", "function:outer.inner.work"],
		},
		{
			filePath: "implementation.rs",
			text: "struct Worker;\ntrait Service { fn run(&self); }\nimpl Service for Worker { fn run(&self) {} }\n",
			expected: ["Service.run", "Worker.run"],
			functionsOnly: true,
		},
		{
			filePath: "receiver.go",
			text: "package receiver\ntype Server struct{}\nfunc (s Server) Stop() {}\n",
			expected: ["type:Server", "method:Server.Stop"],
		},
	])("preserves complete declaration scope in $filePath", ({ filePath, text, expected, functionsOnly }) => {
		const units = parseCodeUnits(filePath, text).units;
		const actual = functionsOnly === true
			? units.filter((unit) => unit.kind === "function").map((unit) => unit.qualifiedName)
			: units.map((unit) => `${unit.kind}:${unit.qualifiedName}`);
		expect(actual).toEqual(expected);
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

	it.each([
		["foo('./not-import')", []],
		["describe('suite')", []],
		["test('works')", []],
		["require('./dependency')", ["./dependency"]],
		["import('./lazy')", ["./lazy"]],
	])("只把真实模块加载识别为 JavaScript import: %s", (source, expected) => {
		expect(analyzeCodeFile("a.ts", source).imports.map((item) => item.specifier)).toEqual(expected);
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

	it.each([
		{
			text: "retry retry retry once",
			expected: new Map([
				["retry", 3],
				["once", 1],
			]),
		},
		{
			text: "RetryWorker RetryWorker",
			expected: new Map([
				["retryworker", 2],
				["retry", 2],
				["worker", 2],
			]),
		},
	])("tokenizeText 按 occurrence 累计原始和拆分 token 的 TF: $text", ({ text, expected }) => {
		expect(tokenizeText(text)).toEqual(expected);
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
