import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeRead } from "../../../src/harness/file-tools/pi/adapters/read.ts";
import { FileToolsHost } from "../../../src/harness/file-tools/runtime/host.ts";
import { isReadSuccess } from "../../../src/harness/file-tools/read/guards.ts";
import { formatReadTextContent } from "../../../src/harness/file-tools/read/presenter.ts";
import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import { deferred } from "../../helpers/async.ts";
import { createGrepTestContext, expectGrepSuccess } from "./grep-fixtures.ts";
import { createManager, createProtocolServer, send, useTransportFixture } from "../lsp/transport/fixtures.ts";

const context = createGrepTestContext();
const transport = useTransportFixture();
let host: FileToolsHost;
beforeEach(() => { host = new FileToolsHost(); });
afterEach(() => host.dispose());

const text = [
	"/** docs */",
	"function outer(",
	"  values: string[],",
	") {",
	"  function inner() {",
	"    return work();",
	"  }",
	"  return values.map((value) => {",
	"    return inner() + value;",
	"  });",
	"}",
].join("\n");
const outer = {
	name: "outer", kind: 12,
	range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
	selectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 14 } },
};

async function setup(options: Parameters<typeof createProtocolServer>[1] = {}, settings: Record<string, unknown> = {}) {
	await writeFile(path.join(context.workspace, "code.ts"), text);
	const server = await createProtocolServer(transport, {
		capabilities: { documentSymbolProvider: true, referencesProvider: true, callHierarchyProvider: true },
		...options,
		routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [outer] }),
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: [] }),
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: null }),
			...options.routes,
		},
	});
	const manager = await createManager(transport, server, settings);
	return {
		server,
		read: (lines?: string, signal?: AbortSignal) => executeRead({ path: "code.ts", ...(lines === undefined ? {} : { lines }) }, {
			host, cwd: context.workspace, sessionId: "structure", pathAccess: { mounts: [], protectedRoots: [], managedSchemes: [] },
			model: undefined, lsp: async () => manager,
			...(signal === undefined ? {} : { signal }),
		}),
		grep: async (query: string) => expectGrepSuccess(await grepWorkspaceFiles(context.workspace, { query }, undefined, {
			lsp: { codeAnalysis: (input) => manager.codeAnalysis(input), prepareCodeAnalysis: (input) => manager.prepareCodeAnalysis(input) },
		})),
	};
}

function readDetails(result: Awaited<ReturnType<typeof executeRead>>) {
	if (!isReadSuccess(result.details)) throw new Error(`read failed: ${JSON.stringify(result.details)}`);
	return result.details;
}

describe("shared read/grep structure", () => {
	it("LSP 保留外层范围，两种工具补全声明、内层函数和匿名回调", async () => {
		const tools = await setup();
		const read = readDetails(await tools.read("6,9"));
		expect(tools.server.methods.filter((method) => method === "textDocument/documentSymbol")).toHaveLength(1);
		expect(read.segments[0]?.structure?.enclosing_symbol).toEqual({ name: "outer.inner", kind: "function", line: 5, end_line: 7 });
		expect(read.segments[1]?.structure?.enclosing_symbol).toEqual({ name: "outer", kind: "function", line: 1, end_line: 11 });
		const inner = await tools.grep("work");
		expect(inner.regions).toHaveLength(1);
		expect(inner.regions[0]).toMatchObject({ start_line: 5, end_line: 7, symbol: "outer.inner" });
		const anonymous = await tools.grep("inner\\(\\) \\+");
		expect(anonymous.regions).toHaveLength(1);
		expect(anonymous.regions[0]).toMatchObject({
			start_line: 8, end_line: 10, kind: "function", enclosing_symbol: "outer",
			context: "return values.map((value) => {",
		});
		expect(formatCompactGrepResult(anonymous)).toBe('<grep>\ncode.ts:8-10 in outer\n  return values.map((value) => {\n  9:     return inner() + value;\n</grep>');
		expect(anonymous.regions[0]?.symbol).toBeUndefined();
		const result = await tools.grep("outer");
		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]).toMatchObject({ start_line: 1, end_line: 11, declaration: "function outer( values: string[], )" });
	});

	it("平面符号的导航位置不能缩短实现范围，read 与 grep 均采用语法补全", async () => {
		const uri = pathToFileURL(path.join(context.workspace, "code.ts")).toString();
		const tools = await setup({ routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [{
				name: "outer", kind: 12, location: { uri, range: outer.selectionRange },
			}] }),
		} });
		const read = readDetails(await tools.read("3"));
		expect(read.segments[0]?.structure?.enclosing_symbol).toMatchObject({ name: "outer", line: 2, end_line: 11 });
		const grep = await tools.grep("values: string");
		expect(grep.regions).toHaveLength(1);
		expect(grep.regions[0]).toMatchObject({ symbol: "outer", start_line: 2, end_line: 11 });
	});

	it("禁用 LSP 时 partial read 仍提供语法结构，完整 read 不启动分析服务", async () => {
		const tools = await setup({}, { enabled: false });
		const full = readDetails(await tools.read());
		expect(full.segments[0]?.structure).toBeUndefined();
		const partial = await tools.read("6");
		expect(readDetails(partial).segments[0]?.structure?.enclosing_symbol?.name).toBe("outer.inner");
		expect(partial.content).toEqual([expect.objectContaining({ text: expect.stringContaining('<structure enclosing="function outer.inner 5-7"/>') })]);
		expect(tools.server.connections).toBe(0);
	});

	it("LSP 的生成回调名不替代具名归属", async () => {
		const callbackRange = { start: { line: 7, character: 20 }, end: { line: 9, character: 3 } };
		const tools = await setup({ routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [{
				...outer, children: [{ name: "values.map() callback", kind: 12, range: callbackRange, selectionRange: callbackRange }],
			}] }),
		} });
		const read = await tools.read("9");
		expect(read.content).toEqual([{ type: "text", text: '<read path="code.ts" lines="9-9/11">\n    return inner() + value;\n<structure enclosing="function outer 1-11"/>\n</read>' }]);
		const grep = await tools.grep("inner\\(\\) \\+");
		expect(grep.regions).toHaveLength(1);
		expect(grep.regions[0]).toMatchObject({ start_line: 8, end_line: 10, enclosing_symbol: "outer", context: "return values.map((value) => {" });
		expect(grep.regions[0]?.symbol).toBeUndefined();
	});

	it.each([
		{ name: "嵌套回调", text: "function outer() {\n  return values.map((value) => {\n    return value.filter((entry) => {\n      return needle(entry);\n    });\n  });\n}", lines: "4", range: [3, 5], enclosing: "outer", structure: "function outer 1-7", header: "return value.filter((entry) => {" },
		{ name: "顶层路由回调", text: 'app.get(\n  "/users",\n  async (req, res) => {\n    return needle(req);\n  },\n);', lines: "4", range: [3, 5], header: 'app.get( "/users", async (req, res) => {' },
		{ name: "绑定箭头函数", text: "const transform = (value) => {\n  return needle(value);\n};", lines: "2", range: [1, 3], symbol: "transform", structure: "declaration transform 1-3" },
		{ name: "对象属性回调", text: "const handlers = {\n  onClick: () => {\n    return needle();\n  },\n};", lines: "3", range: [2, 4], symbol: "handlers.onClick", structure: "declaration handlers.onClick 2-4" },
	])("禁用 LSP 时 $name 保留定位与具名归属", async (sample) => {
		const tools = await setup({}, { enabled: false });
		await writeFile(path.join(context.workspace, "code.ts"), sample.text);
		const read = await tools.read(sample.lines);
		const rendered = read.content.map((item) => "text" in item ? item.text : "").join("\n");
		if (sample.structure === undefined) expect(rendered).not.toContain("<structure");
		else expect(rendered).toContain(`<structure enclosing="${sample.structure}"/>`);
		const grep = await tools.grep("needle");
		expect(grep.regions).toHaveLength(1);
		const region = grep.regions[0];
		expect(region).toMatchObject({ start_line: sample.range[0], end_line: sample.range[1] });
		expect(region?.symbol).toBe(sample.symbol);
		expect(region?.enclosing_symbol).toBe(sample.enclosing);
		if (sample.header !== undefined) {
			expect(region?.context).toBe(sample.header);
			expect(region?.declaration).toBeUndefined();
			expect(formatCompactGrepResult(grep)).toContain(`\n  ${sample.header}\n`);
		}
		expect(region?.match_lines).toEqual([Number(sample.lines)]);
		expect(tools.server.connections).toBe(0);
	});

	it("错误恢复区域不成为确定边界，解析状态只保留在 details", async () => {
		const tools = await setup({ capabilities: {} });
		await writeFile(path.join(context.workspace, "code.ts"), "function good() { return 1; }\nfunction broken( {\n  work();\n");
		const read = await tools.read("3");
		expect(readDetails(read).segments[0]?.structure?.parse_errors?.length).toBeGreaterThan(0);
		expect(read.content).toEqual([{ type: "text", text: '<read path="code.ts" lines="3-3/3">\n  work();\n</read>' }]);
		const grep = await tools.grep("work");
		expect(grep.regions[0]?.kind).toBe("text");
		expect(grep.structure_issues?.some((issue) => issue.kind === "parse")).toBe(true);
		expect(formatCompactGrepResult(grep).split("\n")[0]).toBe("<grep>");
	});

	it("范围冲突只在 details 保留双方证据，不悄悄覆盖 LSP", async () => {
		const tools = await setup({ routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [{
				...outer, range: { start: outer.range.start, end: { line: 3, character: 3 } },
			}] }),
		} });
		const result = await tools.read("3");
		const read = readDetails(result);
		expect(read.segments[0]?.structure?.conflicts?.length).toBeGreaterThan(0);
		expect(result.content).toEqual([{ type: "text", text: '<read path="code.ts" lines="3-3/11">\n  values: string[],\n<structure enclosing="function outer 1-4"/>\n</read>' }]);
		const grep = await tools.grep("values: string");
		expect(grep.structure_issues?.some((issue) => issue.kind === "range")).toBe(true);
		expect(formatCompactGrepResult(grep).split("\n")[0]).toBe("<grep>");
		const across = await tools.grep("function outer|return values");
		expect(across.regions).toHaveLength(2);
		expect(across.regions.flatMap((region) => region.match_lines ?? []).sort((a, b) => a - b)).toEqual([2, 8]);
	});

	it.each([0, 190])("导航不占行预算，字节预算重算后对应最终正文（注释宽度 %i）", async (padding) => {
		await context.useConfig({ read_lines: 8, read_bytes: 1024 });
		const tools = await setup({}, { enabled: false });
		const content = ["// 1", "// 2", "// 3", "// 4", "// 5", "function a() {}", "", "", "function b() {}", "", "", "function c() {}"]
			.map((line) => line.startsWith("//") ? line.padEnd(padding, ".") : line).join("\n");
		await writeFile(path.join(context.workspace, "code.ts"), content);
		const read = readDetails(await tools.read());
		const segment = read.segments[0];
		if (segment === undefined) throw new Error("missing read segment");
		expect(segment.end_line).toBe(padding === 0 ? 8 : 4);
		expect(read.continuation).toEqual({ lines: `${segment.end_line + 1}-12` });
		expect(segment.structure?.remaining_symbols?.map((item) => item.line)).toEqual([6, 9, 12].filter((line) => line > segment.end_line));
		expect(Buffer.byteLength(formatReadTextContent(read))).toBeLessThanOrEqual(1024);
	});

	it("大纲关闭时不加载分析服务，partial read 的包围提示不受影响", async () => {
		await context.useConfig({ read_lines: 1, read_outline_symbols: 0 });
		const tools = await setup();
		const full = readDetails(await tools.read());
		expect(full.truncated).toBe(true);
		expect(full.segments[0]?.structure).toBeUndefined();
		expect(tools.server.connections).toBe(0);
		const partial = readDetails(await tools.read("6"));
		expect(partial.segments[0]?.structure?.enclosing_symbol?.name).toBe("outer.inner");
		expect(tools.server.connections).toBe(1);
	});

	it("LSP 模块加载失败时，语法大纲仍按 read 自身预算返回", async () => {
		await context.useConfig({ read_lines: 1, read_outline_symbols: 1 });
		await writeFile(path.join(context.workspace, "code.ts"), "// header\nfunction first() {}\nfunction second() {}\n");
		const result = await executeRead({ path: "code.ts" }, {
			host, cwd: context.workspace, sessionId: "outline-fallback", model: undefined,
			pathAccess: { mounts: [], protectedRoots: [], managedSchemes: [] },
			lsp: async () => { throw new Error("LSP unavailable"); },
		});
		expect(readDetails(result).segments[0]?.structure?.remaining_symbols).toEqual([
			{ name: "first", kind: "function", line: 2, end_line: 2 },
		]);
	});

	it("read 在语义请求期间取消时不返回半份正文或结构", async () => {
		const entered = deferred<void>();
		const tools = await setup({ routes: { "textDocument/documentSymbol": () => entered.resolve() } });
		const controller = new AbortController();
		const pending = tools.read("6", controller.signal);
		await entered.promise;
		controller.abort();
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		await tools.server.cancelled;
	});
});
