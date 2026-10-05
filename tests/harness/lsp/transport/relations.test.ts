import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallHierarchyItem, CallHierarchyPrepareParams, DefinitionParams, DocumentSymbol, Range } from "vscode-languageserver-protocol";
import { analyzeCodeFile } from "../../../../src/harness/code-index/parser.ts";
import type { CodeCallRelation } from "../../../../src/harness/code-index/relation-types.ts";
import { pathToFileUri } from "../../../../src/harness/lsp/protocol/uri.ts";
import { deferred } from "../../../helpers/async.ts";
import { createManager, createProtocolServer, directClient, send, useTransportFixture } from "./fixtures.ts";

const transport = useTransportFixture();
const range = (line: number, start: number, end: number): Range => ({ start: { line, character: start }, end: { line, character: end } });
const uri = (file: string) => pathToFileUri(path.join(transport.workspace, file));
const dep = "export function send() {}\n";
const sendSymbol: DocumentSymbol = { name: "send", kind: 12, range: range(0, 0, 25), selectionRange: range(0, 16, 20) };
const runSymbol = (endLine: number, endCharacter: number, startLine = 0): DocumentSymbol => ({
	name: "run", kind: 12, range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: endCharacter } },
	selectionRange: range(startLine, 9, 12),
});

type Options = Parameters<typeof createProtocolServer>[1];
async function setup(text: string, symbol: DocumentSymbol[], options: Options = {}, extra: Record<string, string> = { "dep.ts": dep }) {
	const server = await createProtocolServer(transport, {
		...options,
		capabilities: { textDocumentSync: 1, documentSymbolProvider: true, callHierarchyProvider: true, definitionProvider: true, referencesProvider: true, ...options.capabilities },
		routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: symbol }),
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: [] }),
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: [] }),
			"callHierarchy/incomingCalls": (message, socket) => send(socket, { id: message.id, result: [] }),
			"callHierarchy/outgoingCalls": (message, socket) => send(socket, { id: message.id, result: [] }),
			"textDocument/definition": (message, socket) => send(socket, { id: message.id, result: [{ uri: uri("dep.ts"), range: sendSymbol.selectionRange }] }),
			...options.routes,
		},
	});
	const manager = await createManager(transport, server);
	const texts = new Map(Object.entries({ "main.ts": text, ...extra }));
	const analyze = (signal?: AbortSignal, paths = ["main.ts"]) => manager.codeAnalysis({
		...(signal === undefined ? {} : { signal }),
		root: transport.workspace, query: "run", targets: paths.map((path) => ({ path, ranges: [{ startByte: Buffer.byteLength(text.slice(0, text.indexOf("run"))), endByte: Buffer.byteLength(text.slice(0, text.indexOf("run"))) + 3 }] })),
		allowRelated: false, limit: 8,
		syntax: (document, signal) => analyzeCodeFile(document.path, document.text, signal),
		async load(file) {
			const content = texts.get(file);
			return content === undefined ? undefined : { path: file, text: content, hash: `hash:${content}`, filePath: path.join(transport.workspace, file) };
		},
	});
	return { server, analyze };
}

function calls(analysis: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["analyze"]>>): CodeCallRelation[] {
	return analysis?.relations.filter((relation): relation is CodeCallRelation => relation.kind === "call") ?? [];
}

describe("LSP relation evidence", () => {
	it("不同目标文件报告同一调用点时，在查询级保留多目标歧义", async () => {
		const text = "function run() {}\n";
		const symbol = runSymbol(0, text.trimEnd().length);
		const callerText = "function caller() { run(); }\n";
		const tools = await setup(text, [symbol], { routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => {
				const { textDocument } = message.params as CallHierarchyPrepareParams;
				send(socket, { id: message.id, result: [{ ...symbol, uri: textDocument.uri }] });
			},
			"callHierarchy/incomingCalls": (message, socket) => send(socket, { id: message.id, result: [{
				from: { name: "caller", kind: 12, uri: uri("caller.ts"), range: range(0, 0, callerText.trimEnd().length), selectionRange: range(0, 9, 15) },
				fromRanges: [range(0, callerText.indexOf("run"), callerText.indexOf("run") + 3)],
			}] }),
		} }, { "other.ts": text, "caller.ts": callerText });
		const analysis = await tools.analyze(undefined, ["main.ts", "other.ts"]);
		expect(calls(analysis)).toHaveLength(2);
		expect(calls(analysis).every((call) => call.resolution === "ambiguous")).toBe(true);
		expect(analysis?.results.map((result) => result.file?.analysis.units[0]?.authority)).toEqual(["defined", "defined"]);
		expect(analysis?.results.every((result) => result.file?.analysis.units[0]?.navigation?.[0]?.ambiguous === true)).toBe(true);
	});

	it.each([false, true])("关系位置的验证状态不受失败顺序影响，反序=%s", async (reverse) => {
		const text = "function run() {}\n";
		const references = ["file:///outside.ts", uri("missing.ts")].map((uri) => ({ uri, range: range(0, 0, 1) }));
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)], { routes: {
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: reverse ? references.reverse() : references }),
		} });
		const analysis = await tools.analyze();
		expect(analysis?.results[0]?.file?.analysis.units[0]?.relationStatus?.validation).toBe("unavailable");
	});

	it("调用层次缺失时在精确调用点解析导入别名，接受 DefinitionLink", async () => {
		const text = "import { send as deliver } from './dep';\nfunction run() {\n  deliver();\n}\n";
		const tools = await setup(text, [runSymbol(3, 1, 1)], {
			capabilities: { callHierarchyProvider: false },
			routes: { "textDocument/definition": (message, socket) => send(socket, { id: message.id, result: [{
				targetUri: uri("dep.ts"), targetRange: sendSymbol.range, targetSelectionRange: sendSymbol.selectionRange,
			}] }) },
		});
		const analysis = await tools.analyze();
		expect(calls(analysis)).toMatchObject([{ source: "definition", resolution: "resolved", site: { line: 3, column: 3 }, targets: [{ status: "ok", binding: "callable", location: { path: "dep.ts", line: 1, column: 17 } }] }]);
		expect(analysis?.results[0]?.file?.analysis.units[0]?.navigation).toMatchObject([{ kind: "callee", source: "definition", path: "dep.ts" }]);
		expect(tools.server.messages.find((message) => message.method === "textDocument/definition")?.params).toMatchObject({ position: { line: 2, character: 2 } });
		expect(tools.server.methods).not.toContain("textDocument/prepareCallHierarchy");
	});

	it("缺少文档符号能力仍可利用语法调用点和定义能力", async () => {
		const tools = await setup("function run() { send(); }\n", [], { capabilities: { documentSymbolProvider: false, callHierarchyProvider: false } });
		const analysis = await tools.analyze();
		expect(analysis?.results.map((result) => result.coverage)).toEqual([{ path: "main.ts", symbols: "unsupported" }]);
		expect(calls(analysis)).toMatchObject([{ source: "definition", resolution: "resolved" }]);
		expect(tools.server.methods).not.toContain("textDocument/documentSymbol");
	});

	it("保留所有 prepare 候选及 data，一项请求失败不撤销其他候选", async () => {
		const text = "function run() { send(); }\n";
		const item = { ...runSymbol(0, text.trimEnd().length), uri: uri("main.ts") };
		const prepared = [{ ...item, data: "first" }, { ...item, data: "second" }];
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)], { routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: prepared }),
			"callHierarchy/incomingCalls": (message, socket) => {
				const { item } = message.params as { item: CallHierarchyItem };
				send(socket, item.data === "first" ? { id: message.id, error: { code: -32000, message: "failed" } } : { id: message.id, result: [] });
			},
			"callHierarchy/outgoingCalls": (message, socket) => {
				const { item } = message.params as { item: CallHierarchyItem };
				send(socket, { id: message.id, result: [{ to: { ...sendSymbol, uri: uri(item.data === "first" ? "dep.ts" : "other.ts") }, fromRanges: [range(0, 17, 21)] }] });
			},
		} }, { "dep.ts": dep, "other.ts": dep });
		const analysis = await tools.analyze();
		expect(tools.server.messages.filter((message) => message.method === "callHierarchy/outgoingCalls").map((message) => message.params)).toEqual(prepared.map((item) => ({ item })));
		expect(calls(analysis)).toHaveLength(2);
		expect(calls(analysis).every((call) => call.source === "hierarchy" && call.resolution === "ambiguous")).toBe(true);
		expect(analysis?.results[0]?.file?.analysis.units[0]?.relationStatus).toMatchObject({ incomingCalls: "unavailable", outgoingCalls: "ok" });
		expect(tools.server.methods).not.toContain("textDocument/definition");
	});

	it("递归边保留并去重，自引用不提升排序等级", async () => {
		const text = "function run() { run(); }\n";
		const symbol = runSymbol(0, text.trimEnd().length);
		const item = { ...symbol, uri: uri("main.ts") };
		const tools = await setup(text, [symbol], { routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: [item] }),
			"callHierarchy/incomingCalls": (message, socket) => send(socket, { id: message.id, result: [{ from: item, fromRanges: [range(0, 17, 20)] }] }),
			"callHierarchy/outgoingCalls": (message, socket) => send(socket, { id: message.id, result: [{ to: item, fromRanges: [range(0, 17, 20)] }] }),
		} });
		const analysis = await tools.analyze();
		expect(calls(analysis)).toHaveLength(1);
		expect(calls(analysis)[0]).toMatchObject({ source: "hierarchy", resolution: "resolved", caller: { path: "main.ts" }, targets: [{ location: { path: "main.ts" } }] });
		expect(analysis?.results[0]?.file?.analysis.units[0]?.authority).toBe("defined");
	});

	it("嵌套匿名回调保留自己的归属，参数绑定不能冒充调用实现", async () => {
		const lines = ["function run(callback) {", "  callback();", "  consume(callback);", "  consume(() => send());", "}"];
		const tools = await setup(lines.join("\n"), [runSymbol(4, 1)], { routes: {
			"textDocument/definition": (message, socket) => {
				const { position } = message.params as DefinitionParams;
				send(socket, { id: message.id, result: position.line === 1
					? { uri: uri("main.ts"), range: range(0, 13, 21) }
					: { uri: uri("dep.ts"), range: sendSymbol.selectionRange } });
			},
		} });
		const analysis = await tools.analyze();
		const edges = calls(analysis);
		expect(edges).toHaveLength(4);
		expect(edges[0]).toMatchObject({ source: "definition", resolution: "indirect", targets: [{ binding: "indirect" }] });
		const outer = analysis?.results[0]?.file?.analysis.units.find((unit) => unit.name === "run");
		const callback = analysis?.results[0]?.file?.analysis.units.find((unit) => unit.name === undefined && unit.kind === "function");
		expect(callback).toBeDefined();
		expect(edges.at(-1)?.caller?.unitId).toBe(callback?.id);
		expect(edges[0]?.caller?.unitId).toBe(outer?.id);
		expect(tools.server.messages.filter((message) => message.method === "textDocument/definition")).toHaveLength(4);
	});

	it("动态返回值调用保持未知，不把内层工厂误认作外层调用目标", async () => {
		const text = "function run() { factory()(); }\n";
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)]);
		const edges = calls(await tools.analyze());
		expect(edges).toHaveLength(2);
		expect(edges.filter((edge) => edge.source === "syntax")).toMatchObject([{ resolution: "unknown", targets: [] }]);
		expect(tools.server.messages.filter((message) => message.method === "textDocument/definition")).toHaveLength(1);
	});

	it("多定义和 scope 外目标全部保留为候选，不能压成唯一目标", async () => {
		const text = "function run() { send(); }\n";
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)], { routes: {
			"textDocument/definition": (message, socket) => send(socket, { id: message.id, result: [
				{ uri: uri("dep.ts"), range: sendSymbol.selectionRange },
				{ uri: uri("ignored.ts"), range: sendSymbol.selectionRange },
			] }),
		} });
		const analysis = await tools.analyze();
		expect(calls(analysis)).toMatchObject([{ resolution: "ambiguous", targets: [{ status: "ok" }, { status: "unavailable" }] }]);
		expect(analysis?.results[0]?.file?.analysis.units[0]?.navigation).toMatchObject([{ kind: "callee", ambiguous: true, path: "dep.ts" }]);
	});

	it("Unicode 和 CRLF 下查询成员名而不是接收者", async () => {
		const lines = ["function run() {", "  const emoji = '😀'; client.send();", "}"];
		const tools = await setup(lines.join("\r\n"), [runSymbol(2, 1)]);
		expect(calls(await tools.analyze())[0]?.resolution).toBe("resolved");
		const request = tools.server.messages.find((message) => message.method === "textDocument/definition");
		expect(request?.params).toMatchObject({ position: { line: 1, character: lines[1]?.indexOf("send") } });
	});

	it("定义查询有界，剩余语法调用显式保留未知", async () => {
		const lines = ["function run() {", ...Array.from({ length: 20 }, () => "  send();"), "}"];
		const tools = await setup(lines.join("\n"), [runSymbol(21, 1)]);
		const analysis = await tools.analyze();
		expect(calls(analysis)).toHaveLength(20);
		expect(calls(analysis).filter((call) => call.status === "skipped")).toHaveLength(4);
		expect(tools.server.messages.filter((message) => message.method === "textDocument/definition")).toHaveLength(16);
		expect(analysis?.results[0]?.file?.analysis.units[0]?.relationStatus?.definitions).toBe("skipped");
	});

	it("嵌套函数调用外层定义形成外部调用证据，不被范围包含误删", async () => {
		const text = "function run() {\n  function inner() { run(); }\n}\n";
		const tools = await setup(text, [runSymbol(2, 1)], { routes: {
			"textDocument/definition": (message, socket) => send(socket, { id: message.id, result: { uri: uri("main.ts"), range: range(0, 9, 12) } }),
		} });
		const analysis = await tools.analyze();
		expect(calls(analysis)).toMatchObject([{ source: "definition", resolution: "resolved", caller: { line: 2 } }]);
		expect(analysis?.results[0]?.file?.analysis.units.find((unit) => unit.name === "run")?.authority).toBe("called");
	});

	it("模块初始化调用没有函数归属，但仍保存静态目标", async () => {
		const tools = await setup("run();\n", []);
		const edges = calls(await tools.analyze());
		expect(edges).toMatchObject([{ source: "definition", resolution: "resolved", site: { line: 1, column: 1 } }]);
		expect(edges[0]?.caller).toBeUndefined();
	});

	it("格式错误的定义响应只使该调用保持未知，已取得的引用仍保留", async () => {
		const text = "function run() { send(); }\n";
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)], { routes: {
			"textDocument/definition": (message, socket) => send(socket, { id: message.id, result: [{
				targetUri: uri("dep.ts"), targetRange: range(0, 0, 5), targetSelectionRange: sendSymbol.selectionRange,
			}] }),
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: [{ uri: uri("caller.ts"), range: range(0, 0, 3) }] }),
		} }, { "dep.ts": dep, "caller.ts": "run;\n" });
		const analysis = await tools.analyze();
		expect(calls(analysis)).toMatchObject([{ source: "syntax", status: "unavailable", resolution: "unknown", targets: [] }]);
		expect(analysis?.results[0]?.file?.analysis.units[0]).toMatchObject({ authority: "referenced", navigation: [{ kind: "reference", path: "caller.ts" }] });
	});

	it("调用位置越出调用方范围时拒绝该响应，由精确调用点补充", async () => {
		const first = "function run() { send(); }";
		const text = `${first}\nconst other = 1;\n`;
		const symbol = runSymbol(0, first.length);
		const item = { ...symbol, uri: uri("main.ts") };
		const tools = await setup(text, [symbol], { routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: [item] }),
			"callHierarchy/outgoingCalls": (message, socket) => send(socket, { id: message.id, result: [{
				to: { ...sendSymbol, uri: uri("dep.ts") }, fromRanges: [range(1, 6, 11)],
			}] }),
		} });
		const analysis = await tools.analyze();
		expect(calls(analysis)).toMatchObject([{ source: "definition", resolution: "resolved", site: { line: 1 } }]);
		expect(analysis?.results[0]?.file?.analysis.units.find((unit) => unit.name === "run")?.relationStatus?.outgoingCalls).toBe("unavailable");
	});

	it("定义查询期间取消会取消协议请求、释放文档且不返回部分分析", async () => {
		const entered = deferred<void>();
		const closed = deferred<void>();
		const text = "function run() { send(); }\n";
		const tools = await setup(text, [runSymbol(0, text.trimEnd().length)], {
			routes: { "textDocument/definition": () => entered.resolve() },
			onMessage: (message) => { if (message.method === "textDocument/didClose") closed.resolve(); },
		});
		const controller = new AbortController();
		const pending = tools.analyze(controller.signal);
		await entered.promise;
		controller.abort();
		expect(await pending).toBeUndefined();
		await tools.server.cancelled;
		await closed.promise;
	});

	it("关系请求结束后才关闭临时文档，并将并发新版查询排在同 URI 队列后", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const file = path.join(transport.workspace, "main.ts");
		const oldText = "function run() { send(); }";
		const newText = "function run() {}";
		const item = { ...runSymbol(0, oldText.length), uri: uri("main.ts") };
		const server = await createProtocolServer(transport, { capabilities: { textDocumentSync: 1, documentSymbolProvider: true, callHierarchyProvider: true }, routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [] }),
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: [item] }),
			"callHierarchy/incomingCalls": (message, socket) => {
				entered.resolve();
				void release.promise.then(() => send(socket, { id: message.id, result: [] }));
			},
			"callHierarchy/outgoingCalls": (message, socket) => send(socket, { id: message.id, result: [] }),
		} });
		const client = directClient(transport, server, 1);
		const first = client.withDocument(file, oldText, undefined, async (document) => {
			await document.symbols();
			const candidates = await document.prepareCalls({ line: 0, character: 9 });
			const selected = candidates?.[0];
			if (selected === undefined) throw new Error("Missing prepared symbol");
			await document.incomingCalls(selected);
			await document.outgoingCalls(selected);
			return "old snapshot";
		});
		await entered.promise;
		const second = client.documentSymbols(file, newText);
		release.resolve();
		expect(await first).toBe("old snapshot");
		expect(await second).toEqual([]);
		const close = server.methods.indexOf("textDocument/didClose");
		expect(close).toBeGreaterThan(server.methods.indexOf("callHierarchy/outgoingCalls"));
		expect(server.messages.filter((message) => message.method === "textDocument/didOpen").map((message) => message.params)).toMatchObject([
			{ textDocument: { text: oldText } }, { textDocument: { text: newText } },
		]);
	});
});
