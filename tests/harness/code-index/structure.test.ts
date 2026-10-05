import { describe, expect, it } from "vitest";
import { SymbolKind, type Range } from "vscode-languageserver-protocol";
import { analyzeCodeFile } from "../../../src/harness/code-index/parser.ts";
import { mergeCodeStructure } from "../../../src/harness/code-index/structure.ts";
import { analyzeLspDocument } from "../../../src/harness/lsp/analysis/document.ts";
import type { AnalyzedFileIndex } from "../../../src/harness/code-index/types.ts";

function span(text: string, start: number, end: number): Range {
	const position = (offset: number) => ({ line: text.slice(0, offset).split("\n").length - 1, character: offset - text.lastIndexOf("\n", offset - 1) - 1 });
	return { start: position(start), end: position(end) };
}

function named(analysis: AnalyzedFileIndex, name: string) {
	const unit = analysis.units.find((unit) => unit.name === name);
	if (unit === undefined) throw new Error(`missing fixture unit ${name}`);
	return unit;
}

function callOwner(analysis: AnalyzedFileIndex, text: string, callee: string) {
	return analysis.callSites?.find((call) => Buffer.from(text).subarray(call.callee.startByte, call.callee.endByte).toString() === callee)?.ownerId;
}

describe("code structure anchors and bindings", () => {
	it("平面符号校验所属文档，等价文件 URI 可关联，外部 URI 不注入当前文件", () => {
		const text = "function Target() {}";
		const location = span(text, 9, 15);
		const semantic = analyzeLspDocument({ path: "a.ts", text }, [
			{ name: "Target", kind: SymbolKind.Function, location: { uri: "file://localhost/a.ts", range: location } },
			{ name: "Foreign", kind: SymbolKind.Function, location: { uri: "file:///other.ts", range: location } },
		], "file:///a.ts");
		expect(semantic?.units.map((unit) => unit.name)).toEqual(["Target"]);
	});

	it("同名声明按选择位置关联，不借用另一作用域的函数体", async () => {
		const text = "function left() { function same() { first(); } }\nfunction right() { function same() { second(); } }\n";
		const syntax = await analyzeCodeFile("a.ts", text);
		const second = text.lastIndexOf("function same");
		const end = text.indexOf("}", second) + 1;
		const declaration = { name: "same", kind: SymbolKind.Function, range: span(text, second, end), selectionRange: span(text, second + 9, second + 13) };
		const semantic = analyzeLspDocument({ path: "a.ts", text }, [declaration], "file:///a.ts");
		const merged = mergeCodeStructure(syntax, semantic);
		const same = merged.units.filter((unit) => unit.name === "same");
		expect(same).toHaveLength(2);
		expect(same.find((unit) => unit.symbol !== undefined)?.syntax?.range.startByte).toBe(Buffer.byteLength(text.slice(0, second)));
		expect(same.find((unit) => unit.startLine === 1)?.symbol).toBeUndefined();
	});

	it("UTF-16 LSP 坐标与 UTF-8 调用点在中文、非 BMP 字符和 CRLF 下对齐", async () => {
		const text = '// 😀中文\r\nfunction 执行() {\r\n  调用("😀");\r\n}\r\n';
		const start = text.indexOf("执行");
		const syntax = await analyzeCodeFile("a.ts", text);
		const semantic = analyzeLspDocument({ path: "a.ts", text }, [{
			name: "执行", kind: SymbolKind.Function,
			range: span(text, text.indexOf("function"), text.trimEnd().length),
			selectionRange: span(text, start, start + 2),
		}], "file:///a.ts");
		const merged = mergeCodeStructure(syntax, semantic);
		expect(merged.units).toHaveLength(1);
		expect(callOwner(merged, text, "调用")).toBe(named(merged, "执行").id);
	});

	it.each([
		["nested.py", "def outer():\n    def inner():\n        target()\n    return lambda x: inner()\n", undefined, "inner"],
		["bound.py", "def outer():\n    cb = lambda: target()\n    return cb()\n", "cb", "target"],
		["nested.go", "package main\nfunc outer() { cb := func() { target() }; cb() }\n", "cb", "target"],
		["var.go", "package main\nfunc outer() { var cb = func() { target() }; cb() }\n", "cb", "target"],
		["nested.rs", "fn outer() { fn inner() { target(); } let cb = || { inner(); }; cb(); }\n", "cb", "inner"],
		["nested.cpp", "void outer() { auto cb = []() { target(); }; cb(); }\n", "cb", "target"],
	] as const)("%s 保留函数表达式的绑定名称及调用归属", async (path, text, binding, callee) => {
		const analysis = await analyzeCodeFile(path, text);
		const callback = analysis.units.find((unit) => unit.name === binding);
		expect(callback).toBeDefined();
		expect(callback?.parentId).toBe(named(analysis, "outer").id);
		expect(callOwner(analysis, text, callee)).toBe(callback?.id);
	});

	it.each([
		["calls.ts", "function run() { service.target(); new Target(); }", ["service.target", "Target"], ["target", "Target"]],
		["calls.py", "def run():\n    service.target()\n", ["service.target"], ["target"]],
		["calls.go", "package main\nfunc run() { service.Target() }", ["service.Target"], ["Target"]],
		["calls.rs", "fn run() { service.target(); module::target::<i32>(); }", ["service.target", "module::target::<i32>"], ["target", "target"]],
		["calls.c", "void run() { service->target(); }", ["service->target"], ["target"]],
		["calls.cpp", "void run() { module::target<int>(); new Target(); }", ["module::target<int>", "Target"], ["target", "Target"]],
		["calls.sh", "run() { target value; }", ["target"], ["target"]],
	] as const)("%s 的适配器提供调用表达式、查询锚点和函数归属", async (path, text, callees, lookups) => {
		const analysis = await analyzeCodeFile(path, text);
		expect(analysis.parseErrors).toEqual([]);
		const bytes = Buffer.from(text);
		expect(analysis.callSites?.map((call) => bytes.subarray(call.callee.startByte, call.callee.endByte).toString())).toEqual(callees);
		expect(analysis.callSites?.map((call, index) => call.lookupByte === undefined ? undefined
			: bytes.subarray(call.lookupByte, call.lookupByte + Buffer.byteLength(lookups[index] ?? "")).toString())).toEqual(lookups);
		expect(analysis.callSites?.every((call) => call.ownerId === named(analysis, "run").id)).toBe(true);
	});

	it("具名函数表达式保留递归调用的内部归属，箭头函数使用外部绑定", async () => {
		const text = "const bound = function recurse() { recurse(); };\nconst arrow = () => work();\n";
		const analysis = await analyzeCodeFile("a.ts", text);
		expect(analysis.units.map((unit) => unit.name)).toEqual(["bound", "recurse", "arrow"]);
		expect(named(analysis, "recurse").parentId).toBe(named(analysis, "bound").id);
		expect(callOwner(analysis, text, "recurse")).toBe(named(analysis, "recurse").id);
		expect(callOwner(analysis, text, "work")).toBe(named(analysis, "arrow").id);
	});
});
