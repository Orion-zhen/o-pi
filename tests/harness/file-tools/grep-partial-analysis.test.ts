import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import { createGrepTestContext, expectGrepSuccess } from "./grep-fixtures.ts";
import { createManager, createProtocolServer, send, useTransportFixture } from "../lsp/transport/fixtures.ts";

const context = createGrepTestContext();
const transport = useTransportFixture();
const source = "export const Target = () => {\n  return true;\n};\n";
const symbol = {
	name: "Target", kind: 12,
	range: { start: { line: 0, character: 0 }, end: { line: 2, character: 2 } },
	selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
};
const capabilities = {
	documentSymbolProvider: true, workspaceSymbolProvider: { resolveProvider: true },
	referencesProvider: true, callHierarchyProvider: true,
};

type ServerOptions = Parameters<typeof createProtocolServer>[1];

async function setup(options: ServerOptions = {}, timeoutMs = 500) {
	const server = await createProtocolServer(transport, {
		...options,
		capabilities: options.capabilities ?? capabilities,
		routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: [symbol] }),
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: null }),
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: [] }),
			"callHierarchy/outgoingCalls": (message, socket) => send(socket, { id: message.id, result: [] }),
			...options.routes,
		},
	});
	const manager = await createManager(transport, server, { request_timeout_ms: timeoutMs });
	return {
		server,
		search: (query = "Target", signal?: AbortSignal) => grepWorkspaceFiles(context.workspace, { query }, signal, {
			lsp: {
				prepareCodeAnalysis: (input) => manager.prepareCodeAnalysis(input),
				codeAnalysis: (input) => manager.codeAnalysis(input),
			},
		}),
	};
}

describe("grep partial LSP analysis", () => {
	it("混合语言中保留仅支持文档符号的 LSP 文件，无路由文件由 Tree-sitter 补充", async () => {
		await writeFile(path.join(context.workspace, "good.ts"), source);
		await writeFile(path.join(context.workspace, "other.py"), "def Target():\n    return True\n");
		const { search, server } = await setup({ capabilities: { documentSymbolProvider: true } });

		const result = expectGrepSuccess(await search());
		expect(result.regions).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "good.ts", kind: "function", relation_status: expect.objectContaining({ incomingCalls: "unsupported", outgoingCalls: "unsupported", references: "unsupported" }) }),
			expect.objectContaining({ path: "other.py", kind: "function" }),
		]));
		expect(result.stats.text_hits).toBe(2);
		expect(result.analysis).toEqual(expect.arrayContaining([
			{ path: "good.ts", symbols: "ok" }, { path: "other.py", symbols: "unsupported" },
		]));
		expect(server.methods).not.toContain("textDocument/prepareCallHierarchy");
		expect(server.methods).not.toContain("textDocument/references");
		expect(formatCompactGrepResult(result).split("\n")[0]).toBe("<grep>");
	});

	it.each(["error", "invalid-range", "invalid-children", "timeout"] as const)("单文件文档符号 %s 时只补充该文件", async (mode) => {
		await writeFile(path.join(context.workspace, "good.ts"), source);
		await writeFile(path.join(context.workspace, "broken.ts"), source);
		const { search, server } = await setup({ routes: {
			"textDocument/documentSymbol": (message, socket) => {
				if (!JSON.stringify(message.params).includes("broken.ts")) {
					send(socket, { id: message.id, result: [symbol] });
				} else if (mode === "error") {
					send(socket, { id: message.id, error: { code: -32000, message: "document unavailable" } });
				} else if (mode === "invalid-children") {
					send(socket, { id: message.id, result: [{ ...symbol, children: [null] }] });
				} else if (mode === "invalid-range") {
					send(socket, { id: message.id, result: [{ ...symbol, range: {
						start: { line: 0, character: 0 }, end: { line: 99, character: 0 },
					} }] });
				}
			},
		} }, 150);

		const result = expectGrepSuccess(await search());
		expect(result.regions.find((region) => region.path === "good.ts")?.kind).toBe("function");
		expect(result.regions.find((region) => region.path === "broken.ts")?.kind).toBe("declaration");
		expect(result.analysis).toEqual(expect.arrayContaining([
			{ path: "good.ts", symbols: "ok" },
			{ path: "broken.ts", symbols: mode === "timeout" ? "timeout" : "unavailable" },
		]));
		expect(result.regions.flatMap((region) => region.match_lines ?? [])).toEqual([1, 1]);
		if (mode === "timeout") await server.cancelled;
	});

	it.each(["error", "timeout"] as const)("调用层次 %s 后仍保留符号和引用导航", async (mode) => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		await writeFile(path.join(context.workspace, "caller.ts"), "consume();\n");
		const caller = pathToFileURL(path.join(context.workspace, "caller.ts")).toString();
		const { search } = await setup({ routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => {
				if (mode === "error") send(socket, { id: message.id, error: { code: -32000, message: "call hierarchy failed" } });
			},
			"textDocument/references": (message, socket) => send(socket, { id: message.id, result: [{
				uri: caller, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
			}] }),
		} }, 150);

		const result = expectGrepSuccess(await search());
		expect(result.regions[0]).toMatchObject({
			path: "target.ts", kind: "function", roles: ["definition", "referenced"],
			relation_status: { incomingCalls: mode === "timeout" ? "timeout" : "unavailable", references: "ok" },
			navigation: [{ kind: "reference", path: "caller.ts", line: 1, column: 1 }],
		});
		expect(result.analysis).toEqual([{ path: "target.ts", symbols: "ok" }]);
	});

	it("引用请求失败时保留传入调用及其导航", async () => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		await writeFile(path.join(context.workspace, "caller.ts"), "invoke();\n");
		const caller = pathToFileURL(path.join(context.workspace, "caller.ts")).toString();
		const { search } = await setup({ routes: {
			"textDocument/prepareCallHierarchy": (message, socket) => send(socket, { id: message.id, result: [{
				...symbol, uri: pathToFileURL(path.join(context.workspace, "target.ts")).toString(),
			}] }),
			"callHierarchy/incomingCalls": (message, socket) => send(socket, { id: message.id, result: [{
				from: { name: "caller", kind: 12, uri: caller,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
					selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
				fromRanges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }],
			}] }),
			"textDocument/references": (message, socket) => send(socket, { id: message.id, error: { code: -32000, message: "references failed" } }),
		} });

		const result = expectGrepSuccess(await search());
		expect(result.regions[0]).toMatchObject({
			kind: "function", roles: ["definition", "called"],
			relation_status: { incomingCalls: "ok", references: "unavailable" },
			navigation: [{ kind: "caller", path: "caller.ts", line: 1, column: 1 }],
		});
	});

	it("文档符号成功返回 null 时补充语法结构，不误判为 LSP 失败", async () => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		const { search, server } = await setup({ routes: {
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: null }),
		} });
		const result = expectGrepSuccess(await search());
		expect(result.regions[0]?.kind).toBe("declaration");
		expect(result.analysis).toEqual([{ path: "target.ts", symbols: "ok" }]);
		expect(server.methods).toContain("textDocument/references");
		expect(formatCompactGrepResult(result).split("\n")[0]).toBe("<grep>");
	});

	it("引用和调用成功返回空集合时保持成功状态", async () => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		const { search } = await setup();
		const result = expectGrepSuccess(await search());
		expect(result.regions[0]).toMatchObject({ kind: "function", relation_status: { incomingCalls: "ok", references: "ok" } });
		expect(formatCompactGrepResult(result).split("\n")[0]).toBe("<grep>");
	});

	it("零命中时单个 workspace symbol resolve 失败不丢弃其他相关符号", async () => {
		await writeFile(path.join(context.workspace, "good.ts"), source);
		await writeFile(path.join(context.workspace, "broken.ts"), source);
		const uri = (file: string) => pathToFileURL(path.join(context.workspace, file)).toString();
		const { search } = await setup({ routes: {
			"workspace/symbol": (message, socket) => send(socket, { id: message.id, result: [
				{ name: "Target", kind: 12, location: { uri: uri("broken.ts") } },
				{ name: "Target", kind: 12, location: { uri: uri("good.ts"), range: symbol.selectionRange } },
			] }),
			"workspaceSymbol/resolve": (message, socket) => send(socket, { id: message.id, error: { code: -32000, message: "resolve failed" } }),
		} });
		const result = expectGrepSuccess(await search("TargetAlias"));
		expect(result.regions).toEqual([expect.objectContaining({ path: "good.ts", kind: "function", query_match: "semantic" })]);
		expect(result.analysis).toEqual(expect.arrayContaining([
			{ path: "good.ts", symbols: "ok", workspaceSymbols: "ok" },
			{ path: "broken.ts", symbols: "unavailable", workspaceSymbols: "unavailable" },
		]));
	});

	it("工作区符号成功返回空集合时不启动 Tree-sitter 补充", async () => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		const { search, server } = await setup({ routes: {
			"workspace/symbol": (message, socket) => send(socket, { id: message.id, result: null }),
		} });
		const result = expectGrepSuccess(await search("TargetAlias"));
		expect(result.regions).toEqual([]);
		expect(result.stats.parsed_files).toBe(0);
		expect(result.analysis).toEqual([{ path: "target.ts", symbols: "ok", workspaceSymbols: "ok" }]);
		expect(server.methods).not.toContain("textDocument/documentSymbol");
	});

	it("同一文件部分候选超过预算时仍保留已分析的 LSP 符号", async () => {
		const names = ["Target1", "Target2", "Target3", "Target4"];
		const lines = names.map((name) => `export const ${name} = () => 1;`);
		await writeFile(path.join(context.workspace, "target.ts"), `${lines.join("\n")}\n`);
		const uri = pathToFileURL(path.join(context.workspace, "target.ts")).toString();
		const symbols = names.map((name, line) => ({
			name, kind: 12,
			range: { start: { line, character: 0 }, end: { line, character: lines[line]?.length ?? 0 } },
			selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } },
		}));
		const { search } = await setup({ routes: {
			"workspace/symbol": (message, socket) => send(socket, { id: message.id, result: symbols.map((item) => ({
				name: item.name, kind: item.kind, location: { uri, range: item.selectionRange },
			})) }),
			"textDocument/documentSymbol": (message, socket) => send(socket, { id: message.id, result: symbols }),
		} });
		const result = expectGrepSuccess(await search("TargetAlias"));
		expect(result.regions.map((region) => region.symbol)).toEqual(names.slice(0, 3));
		expect(result.regions.every((region) => region.kind === "function")).toBe(true);
		expect(result.analysis).toEqual([{ path: "target.ts", symbols: "skipped", workspaceSymbols: "ok" }]);
		expect(formatCompactGrepResult(result).split("\n")[0]).toBe("<grep>");
	});

	it("用户在关系请求期间取消时不返回已完成的符号结果", async () => {
		await writeFile(path.join(context.workspace, "target.ts"), source);
		const controller = new AbortController();
		const { search } = await setup({ routes: {
			"textDocument/references": () => controller.abort(),
		} });
		await expect(search("Target", controller.signal)).resolves.toMatchObject({
			status: "failed", error: { code: "OPERATION_ABORTED" },
		});
	});
});
