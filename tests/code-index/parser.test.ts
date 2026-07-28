import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileIdentity, createSymbolId } from "../../src/code-index/identity.js";
import { analyzeCodeFile, buildLineIndex, countTextTokenMatches, parseCodeUnits, splitTokens, tokenizeText, tokenizeTextSequence } from "../../src/code-index/parser.js";
import { dependencyPath } from "../helpers/tree-sitter-dependencies.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const treeSitterModules = {
	javascript: dependencyPath("tree-sitter-javascript"),
	typescript: dependencyPath("tree-sitter-typescript"),
	python: dependencyPath("tree-sitter-python"),
	go: dependencyPath("tree-sitter-go"),
	rust: dependencyPath("tree-sitter-rust"),
	c: dependencyPath("tree-sitter-c"),
	cpp: dependencyPath("tree-sitter-cpp"),
};

afterEach(() => {
	vi.useRealTimers();
	vi.doUnmock("../../src/code-index/tree-sitter-loader.js");
});

async function symbols(filePath: string, text: string): Promise<Array<[string, string | undefined, string | undefined]>> {
	return (await parseCodeUnits(filePath, text)).units.map((unit) => [unit.kind, unit.name, unit.qualifiedName]);
}

describe("shared code parser", () => {
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

	it("导入 parser、grep 和注册 extension 时不初始化 runtime，解析时不导入 native grammar 模块", async () => {
		const probe = [
			'const imported = await import("./src/code-index/parser.ts");',
			"const parserApi = imported.default ?? imported;",
			'const { Parser } = await import("web-tree-sitter");',
			"let initializedBeforeParse = true;",
			"try { const parser = new Parser(); parser.delete(); } catch { initializedBeforeParse = false; }",
			'await parserApi.parseCodeUnits("probe.ts", "export function probe() {}\\n");',
			"let initializedAfterParse = true;",
			"try { const parser = new Parser(); parser.delete(); } catch { initializedAfterParse = false; }",
			"process.stdout.write(JSON.stringify({ initializedBeforeParse, initializedAfterParse }));",
		].join("\n");
		const { stdout } = await execFileAsync(process.execPath, ["--import", "jiti/register", "--input-type=module", "--eval", probe], { cwd: process.cwd() });
		expect(JSON.parse(stdout)).toEqual({ initializedBeforeParse: false, initializedAfterParse: true });

		for (const modulePath of Object.values(treeSitterModules)) expect(require.cache[modulePath]).toBeUndefined();

		await import("../../src/file-tools/grep/command.js");
		const { default: fileTools } = await import("../../agent/extensions/file-tools.js");
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		fileTools({
			registerTool() {},
			on(name: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);
		expect(handlers.has("before_agent_start")).toBe(false);

		await parseCodeUnits("notes.txt", "plain text");
		for (const modulePath of Object.values(treeSitterModules)) expect(require.cache[modulePath]).toBeUndefined();

		await parseCodeUnits("first.ts", "export function first() {}\n");
		expect(require.cache[treeSitterModules.typescript]).toBeUndefined();
		expect(require.cache[treeSitterModules.javascript]).toBeUndefined();
		expect(require.cache[treeSitterModules.python]).toBeUndefined();
		expect(require.cache[treeSitterModules.go]).toBeUndefined();
		expect(require.cache[treeSitterModules.rust]).toBeUndefined();
		expect(require.cache[treeSitterModules.c]).toBeUndefined();
		expect(require.cache[treeSitterModules.cpp]).toBeUndefined();
		await expect(Promise.resolve(handlers.get("session_shutdown")?.())).resolves.toBeUndefined();
		expect(require.cache[treeSitterModules.javascript]).toBeUndefined();
		expect(require.cache[treeSitterModules.python]).toBeUndefined();
		expect(require.cache[treeSitterModules.go]).toBeUndefined();
		expect(require.cache[treeSitterModules.rust]).toBeUndefined();
		expect(require.cache[treeSitterModules.c]).toBeUndefined();
		expect(require.cache[treeSitterModules.cpp]).toBeUndefined();
	});

	it("dense ASCII units use exact source slices", async () => {
		const text = Array.from({ length: 64 }, (_, index) => `function item${index}() { return ${index}; }`).join("\n");
		const units = (await parseCodeUnits("dense.ts", text)).units;
		expect(units).toHaveLength(64);
		for (const [index, unit] of units.entries()) {
			expect(unit.name).toBe(`item${index}`);
			expect(text.slice(unit.startByte, unit.endByte)).toBe(`function item${index}() { return ${index}; }`);
		}
	});

	it("提取 C/C++ symbol、文件级 include 和 UTF-8 byte range", async () => {
		const c = await analyzeCodeFile("src/point.c", "// 你😀\n#include <stdio.h>\nint add(int value) { return value; }\n");
		expect(c).toMatchObject({ status: "parsed", index: { language: "c" } });
		expect(c.index.units.map((unit) => [unit.kind, unit.qualifiedName])).toEqual([["function", "add"]]);
		expect(c.imports).toEqual([expect.objectContaining({ specifier: "stdio.h", startLine: 2, endLine: 2 })]);
		expect(c.imports[0]?.startByte).toBe(Buffer.byteLength("// 你😀\n#include <", "utf8"));

		const cpp = await analyzeCodeFile("include/api.H", "namespace api { class Client { public: void run() {} }; }\n");
		expect(cpp).toMatchObject({ status: "parsed", index: { language: "cpp" } });
		expect(cpp.index.units.map((unit) => [unit.kind, unit.qualifiedName])).toEqual([
			["namespace", "api"],
			["class", "api.Client"],
			["method", "api.Client.run"],
		]);
	});

	it("提取 TypeScript、JavaScript、Python、Go 和 Rust symbol，并保留 class method scope", async () => {
		expect(await symbols("auth.ts", "export class AuthService {\n  async login() { return issueToken(); }\n}\nexport const makeSession = () => null;\n")).toEqual([
			["class", "AuthService", "AuthService"],
			["method", "login", "AuthService.login"],
			["declaration", "makeSession", "makeSession"],
		]);
		expect(await symbols("auth.js", "class AuthService { login() { return true; } }\nfunction top() {}\n")).toEqual([
			["class", "AuthService", "AuthService"],
			["method", "login", "AuthService.login"],
			["function", "top", "top"],
		]);
		expect(await symbols("worker.py", "class Worker:\n  def run(self):\n    pass\ndef top():\n  pass\n")).toEqual([
			["class", "Worker", "Worker"],
			["function", "run", "Worker.run"],
			["function", "top", "top"],
		]);
		expect(await symbols("server.go", "package main\ntype Server struct{}\nfunc Start() {}\nfunc (s Server) Stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["function", "Start", "Start"],
			["method", "Stop", "Server.Stop"],
		]);
		expect(await symbols("server.rs", "pub struct Server;\nimpl Server { pub fn start(&self) {} }\npub fn stop() {}\n")).toEqual([
			["type", "Server", "Server"],
			["module", "Server", "Server"],
			["function", "start", "Server.start"],
			["function", "stop", "stop"],
		]);
	});

	it.each([
		{
			filePath: "declaration.ts",
			text: "export class Service { run(value: string) { BODY_SENTINEL(); } }\nexport function multiline(\n value: string,\n count: number\n): boolean { BODY_SENTINEL(); }\n",
			expected: ["export class Service", "run(value: string)", "export function multiline( value: string, count: number ): boolean"],
		},
		{
			filePath: "declaration.js",
			text: "class Service { run(value) { BODY_SENTINEL(); } }\nfunction oneLine() { BODY_SENTINEL(); }\n",
			expected: ["class Service", "run(value)", "function oneLine()"],
		},
		{
			filePath: "declaration.py",
			text: "class Service:\n  def run(\n    self, value: str\n  ) -> str:\n    BODY_SENTINEL()\ndef one_line(): BODY_SENTINEL()\n",
			expected: ["class Service:", "def run( self, value: str ) -> str:", "def one_line():"],
		},
		{
			filePath: "declaration.go",
			text: "package p\ntype Service struct { BODY_SENTINEL string }\nfunc (s Service) Run(\n value string,\n) string { BODY_SENTINEL() }\n",
			expected: ["Service struct", "func (s Service) Run( value string, ) string"],
		},
		{
			filePath: "declaration.rs",
			text: "pub struct Service { BODY_SENTINEL: String }\nimpl Service { pub fn run(\n &self, value: String\n) -> String { BODY_SENTINEL(); value } }\n",
			expected: ["pub struct Service", "impl Service", "pub fn run( &self, value: String ) -> String"],
		},
		{
			filePath: "declaration.c",
			text: "struct Service { int BODY_SENTINEL; };\nint run(\n int value\n) { BODY_SENTINEL(); return value; }\n",
			expected: ["struct Service", "int run( int value )"],
		},
		{
			filePath: "declaration.cpp",
			text: "class Service { public: int run(\n int value\n) { BODY_SENTINEL(); return value; } };\nint oneLine() { BODY_SENTINEL(); }\n",
			expected: ["class Service", "int run( int value )", "int oneLine()"],
		},
	])("为 $filePath 生成紧凑且不含 body 的 declaration", async ({ filePath, text, expected }) => {
		const declarations = (await parseCodeUnits(filePath, text)).units.map((unit) => unit.signature);
		expect(declarations).toEqual(expected);
		expect(declarations.every((value) => value !== undefined && !value.includes("BODY_SENTINEL") && [...value].length <= 240)).toBe(true);
	});

	it("声明中嵌套 callable body 时安全省略 declaration", async () => {
		const unit = (await parseCodeUnits(
			"nested-default.ts",
			"export function run(callback = () => BODY_SENTINEL) { return callback(); }\n",
		)).units[0];
		expect(unit?.signature).toBeUndefined();
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
	])("从 %s AST 提取调用和引用，忽略字符串与注释", async (filePath, text, memberCall) => {
		const unit = (await parseCodeUnits(filePath, text)).units.find((candidate) => candidate.name === "caller");
		if (unit === undefined) throw new Error(`missing caller unit for ${filePath}`);
		expect(unit.calls).toEqual(["target", memberCall]);
		expect(unit.references).toContain("Value");
		expect(unit.references).not.toEqual(expect.arrayContaining(["caller", "fake", "ignored"]));
	});

	it("动态外层调用仍保留可静态识别的内层调用", async () => {
		const unit = (await parseCodeUnits("nested-call.ts", "function caller() { return factory()(); }\n")).units[0];
		expect(unit?.calls).toEqual(["factory"]);
	});

	it("迭代遍历合法的深层 AST，不因 JavaScript 调用栈上限降级", async () => {
		const depth = 2_500;
		const text = `function caller() { return ${"target(".repeat(depth)}value${")".repeat(depth)}; }\n`;
		const analyzed = await analyzeCodeFile("deep.ts", text);
		expect(analyzed.status).toBe("parsed");
		expect(analyzed.index.units).toHaveLength(1);
		expect(analyzed.index.units[0]?.calls).toEqual(["target"]);
	});

	it("在进入本地 Tree-sitter 分析前响应已取消的 signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(analyzeCodeFile("aborted.ts", "export function value() {}\n", { signal: controller.signal }))
			.rejects.toMatchObject({ name: "CodeAnalysisAbortedError" });
	});

	it("函数内部局部声明不拆分为独立 region", async () => {
		const parsed = await parseCodeUnits("a.ts", "export function demo() {\n  const Token = 'Token';\n  return Token;\n}\n");
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
	])("preserves complete declaration scope in $filePath", async ({ filePath, text, expected, functionsOnly }) => {
		const units = (await parseCodeUnits(filePath, text)).units;
		const actual = functionsOnly === true
			? units.filter((unit) => unit.kind === "function").map((unit) => unit.qualifiedName)
			: units.map((unit) => `${unit.kind}:${unit.qualifiedName}`);
		expect(actual).toEqual(expected);
	});

	it("unsupported language 返回 text 空索引，且 file identity 使用规范化内部路径", async () => {
		expect(await parseCodeUnits("./docs\\notes.conf", "section=true\n")).toEqual({
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
	])("详细分析保留 %s 的文件级 import", async (filePath, text, specifier) => {
		const analyzed = await analyzeCodeFile(filePath, text);
		expect(analyzed.status).toBe("parsed");
		expect(analyzed.imports).toEqual([expect.objectContaining({ specifier })]);
	});

	it("提取 dynamic import 和 Go import block，且不把普通 Go 字符串当作 import", async () => {
		expect((await analyzeCodeFile("a.ts", "const lazy = import('./lazy');\n")).imports.map((item) => item.specifier)).toEqual(["./lazy"]);
		const go = await analyzeCodeFile("a.go", "package a\nimport (\n  \"example/one\"\n  alias \"example/two\"\n)\nvar text = \"not/import\"\n");
		expect(go.imports.map((item) => item.specifier)).toEqual(["example/one", "example/two"]);
	});

	it.each([
		["foo('./not-import')", []],
		["describe('suite')", []],
		["test('works')", []],
		["require('./dependency')", ["./dependency"]],
		["import('./lazy')", ["./lazy"]],
	])("只把真实模块加载识别为 JavaScript import: %s", async (source, expected) => {
		expect((await analyzeCodeFile("a.ts", source)).imports.map((item) => item.specifier)).toEqual(expected);
	});

	it("SourceRange 使用 UTF-8 byte offset、1-based inclusive line 和半开字节区间", async () => {
		const text = "// 你😀\nexport function demo() {\n  return '好';\n}\n";
		const unit = (await parseCodeUnits("utf8.ts", text)).units[0];
		if (unit === undefined) throw new Error("missing parsed unit");
		expect(unit).toMatchObject({ startLine: 2, endLine: 4, startByte: Buffer.byteLength("// 你😀\n", "utf8") });
		expect(Buffer.from(text, "utf8").subarray(unit.startByte, unit.endByte).toString("utf8")).toBe("export function demo() {\n  return '好';\n}");
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

	it("tokenizeTextSequence 保留原始及拆分 token 的 occurrence 顺序", () => {
		expect(tokenizeTextSequence("createRetryLoader retry_count")).toEqual([
			"createretryloader", "create", "retry", "loader", "retry_count", "retry", "count",
		]);
	});

	it("symbol ID 由 file、kind、qualified name 和 start byte 决定，同名位置可区分且不依赖 end byte", async () => {
		const input = { fileId: "file:src/a.ts", kind: "function", qualifiedName: "demo", startByte: 12 };
		expect(createSymbolId(input)).toBe("symbol:file%3Asrc%2Fa.ts:function:demo:12");
		expect(createSymbolId(input)).toBe(createSymbolId({ ...input }));
		expect(createSymbolId({ ...input, startByte: 48 })).not.toBe(createSymbolId(input));

		const short = (await parseCodeUnits("a.ts", "export function demo() {}\n")).units[0];
		const long = (await parseCodeUnits("a.ts", "export function demo() { return 1; }\n")).units[0];
		expect(short?.id).toBe(long?.id);
	});

	it("runtime 或 grammar 失败时安全降级为空代码单元", async () => {
		vi.resetModules();
		vi.doMock("../../src/code-index/tree-sitter-loader.js", () => ({
			DEFAULT_PARSE_TIMEOUT_MICROS: 250_000,
			loadTreeSitterParser: async () => ({ failure: { code: "RUNTIME_UNAVAILABLE", message: "simulated grammar failure" } }),
		}));
		const { analyzeCodeFile: analyzeWithFailure, parseCodeUnits: parseWithFailure } = await import("../../src/code-index/parser.js");
		expect(await parseWithFailure("broken.ts", "export function demo() {}\n")).toMatchObject({ language: "typescript", units: [] });
		expect((await analyzeWithFailure("broken.ts", "export function demo() {}\n")).status).toBe("error");
		expect(await parseWithFailure("broken.c", "int demo(void) {}\n")).toMatchObject({ language: "c", units: [] });
		expect((await analyzeWithFailure("broken.c", "int demo(void) {}\n")).status).toBe("error");
	});
});
