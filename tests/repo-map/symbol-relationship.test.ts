import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { analyzeCodeFile } from "../../src/code-index/parser.js";
import { buildRepoMapRelationships } from "../../src/repo-map/relationship-indexer.js";
import { indexRepoMapSymbols } from "../../src/repo-map/symbol-indexer.js";
import type { RepoMapFileRecord } from "../../src/repo-map/types.js";

const root = "/repo";

describe("Repo Map symbol and relationship graph", () => {
	it("indexes every supported language, qualified duplicate names, unsupported files, and parser failures", async () => {
		const sources = new Map([
			["a.ts", "export function tsSymbol() {}\n"],
			["a.tsx", "export function tsxSymbol() { return <div />; }\n"],
			["a.js", "export function jsSymbol() {}\n"],
			["a.jsx", "export function jsxSymbol() { return <div />; }\n"],
			["a.py", "def py_symbol():\n  pass\n"],
			["a.go", "package a\nfunc GoSymbol() {}\n"],
			["a.rs", "pub fn rust_symbol() {}\n"],
			["classes.ts", "class First { same() {} }\nclass Second { same() {} }\n"],
			["notes.txt", "plain\n"],
			["broken.ts", "export function broken() {}\n"],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const result = await indexRepoMapSymbols({
			root,
			files,
			concurrency: 3,
			readText: readSources(sources),
			analyze(filePath, text) {
				const parsed = analyzeCodeFile(filePath, text);
				return filePath === "broken.ts" ? { ...parsed, status: "error", imports: [] } : parsed;
			},
		});
		expect(result).toMatchObject({ parsedFileCount: 8, unsupportedFileCount: 1, parseErrorFileCount: 1 });
		expect(new Set(result.symbols.map((symbol) => symbol.fileId))).toEqual(new Set(files.slice(0, 8).map((file) => file.id)));
		const same = result.symbols.filter((symbol) => symbol.name === "same");
		expect(same.map((symbol) => symbol.qualifiedName)).toEqual(["First.same", "Second.same"]);
		expect(new Set(same.map((symbol) => symbol.id)).size).toBe(2);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "PARSER_ERROR", path: "broken.ts" })]);
	});

	it("reuses valid unchanged parses and reparses only changed files", async () => {
		const firstSources = new Map([
			["a.ts", "import { b } from './b';\nexport function a() { return b(); }\n"],
			["b.ts", "export function b() {}\n"],
		]);
		const firstFiles = [...firstSources].map(([filePath, text]) => indexed(filePath, text));
		const first = await indexRepoMapSymbols({ root, files: firstFiles, concurrency: 2, readText: readSources(firstSources) });
		const firstEdges = buildRepoMapRelationships({ mapId: "a".repeat(64), files: firstFiles, symbols: first.symbols, imports: first.imports });
		const changedSources = new Map(firstSources);
		changedSources.set("b.ts", "export function changed() {}\n");
		const changedFiles = [...changedSources].map(([filePath, text]) => indexed(filePath, text));
		const analyze = vi.fn(analyzeCodeFile);
		const second = await indexRepoMapSymbols({
			root,
			files: changedFiles,
			concurrency: 2,
			readText: readSources(changedSources),
			analyze,
			previous: { files: firstFiles, symbols: first.symbols, edges: firstEdges, diagnostics: [] },
		});
		expect(analyze).toHaveBeenCalledTimes(1);
		expect(analyze).toHaveBeenCalledWith("b.ts", changedSources.get("b.ts"));
		expect(second.reusedParsedFileCount).toBe(1);
		expect(second.imports).toEqual(first.imports);
	});

	it("builds typed edges, resolves unique targets, and keeps ambiguous or missing calls lexical", async () => {
		const sources = new Map([
			["a.ts", "import { helper, Value } from './b';\nexport class First { same() { helper(); Ambiguous(); return Value; } }\nclass Second { same() { Missing(); } }\n"],
			["b.ts", "export function helper() {}\nexport function Ambiguous() {}\nexport const Value = 1;\n"],
			["c.ts", "export function Ambiguous() {}\n"],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const indexedSymbols = await indexRepoMapSymbols({ root, files, concurrency: 2, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "b".repeat(64), files, symbols: indexedSymbols.symbols, imports: indexedSymbols.imports });
		const helper = indexedSymbols.symbols.find((symbol) => symbol.name === "helper");
		const value = indexedSymbols.symbols.find((symbol) => symbol.name === "Value");
		if (helper === undefined || value === undefined) throw new Error("missing targets");
		expect(edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "imports", from: "file:a.ts", to: "file:b.ts", lexicalTarget: "./b", resolution: "syntactic" }),
			expect.objectContaining({ kind: "exports", from: "file:a.ts" }),
			expect.objectContaining({ kind: "calls", to: helper.id, lexicalTarget: "helper", resolution: "lexical" }),
			expect.objectContaining({ kind: "references", to: value.id, lexicalTarget: "Value", resolution: "lexical" }),
			expect.objectContaining({ kind: "calls", to: "lexical:symbol:Missing", lexicalTarget: "Missing", confidence: 0.25 }),
			expect.objectContaining({ kind: "calls", to: "lexical:symbol:Ambiguous", lexicalTarget: "Ambiguous", confidence: 0.35 }),
		]));
		expect(edges.filter((edge) => edge.kind === "contains")).toHaveLength(files.length + indexedSymbols.symbols.length);
		expect(edges.every((edge) => edge.evidence.length > 0)).toBe(true);

		const withoutB = buildRepoMapRelationships({
			mapId: "b".repeat(64),
			files: files.filter((file) => file.path !== "b.ts"),
			symbols: indexedSymbols.symbols.filter((symbol) => symbol.fileId !== "file:b.ts"),
			imports: indexedSymbols.imports,
		});
		expect(withoutB.some((edge) => edge.to === helper.id || edge.to === value.id || edge.to === "file:b.ts")).toBe(false);
	});

	it("只把实际代码调用和引用建立为关系，不把控制语句、字符串和注释当成 symbol 关系", async () => {
		const sources = new Map([
			["caller.ts", [
				"export function caller(value: boolean) {",
				"  if (value) target();",
				"  const message = \"fake() FakeReference\";",
				"  // ignored(); IgnoredReference",
				"  return ActualValue + message.length;",
				"}",
			].join("\n")],
			["targets.ts", [
				"export function target() {}",
				"export function fake() {}",
				"export function ignored() {}",
				"export const ActualValue = 1;",
				"export const FakeReference = 2;",
				"export const IgnoredReference = 3;",
			].join("\n")],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const indexedSymbols = await indexRepoMapSymbols({ root, files, concurrency: 2, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "e".repeat(64), files, symbols: indexedSymbols.symbols, imports: indexedSymbols.imports });
		const caller = indexedSymbols.symbols.find((symbol) => symbol.name === "caller");
		if (caller === undefined) throw new Error("missing caller");
		const callerEdges = edges.filter((edge) => edge.from === caller.id && (edge.kind === "calls" || edge.kind === "references"));

		expect(callerEdges.filter((edge) => edge.kind === "calls").map((edge) => edge.lexicalTarget)).toEqual(["target"]);
		expect(callerEdges.filter((edge) => edge.kind === "references").map((edge) => edge.lexicalTarget)).toEqual(["ActualValue"]);
	});

	it("不会把子 symbol 的调用和引用复制到外层 class symbol", async () => {
		const sources = new Map([
			["container.ts", "export class Container { child() { helper(); return HelperValue; } }\n"],
			["helper.ts", "export function helper() {}\nexport const HelperValue = 1;\n"],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const indexedSymbols = await indexRepoMapSymbols({ root, files, concurrency: 2, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "f".repeat(64), files, symbols: indexedSymbols.symbols, imports: indexedSymbols.imports });
		const container = indexedSymbols.symbols.find((symbol) => symbol.name === "Container");
		const child = indexedSymbols.symbols.find((symbol) => symbol.qualifiedName === "Container.child");
		if (container === undefined || child === undefined) throw new Error("missing nested symbols");

		for (const [kind, lexicalTarget] of [["calls", "helper"], ["references", "HelperValue"]] as const) {
			expect(edges.filter((edge) => edge.kind === kind && edge.lexicalTarget === lexicalTarget).map((edge) => edge.from)).toEqual([child.id]);
		}
	});

	it("解析 C/C++ include 时区分本地 header 与 system header", async () => {
		const sources = new Map([
			["src/main.c", "#include \"local.h\"\nint main(void) { return local(); }\n"],
			["src/local.h", "int local(void);\n"],
			["src/main.cpp", "#include \"header\"\n#include <stdio.h>\nint run() { return helper(); }\n"],
			["src/header.hpp", "int helper();\n"],
			["src/stdio.h", "int repository_stdio(void);\n"],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const indexedSymbols = await indexRepoMapSymbols({ root, files, concurrency: 1, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "g".repeat(64), files, symbols: indexedSymbols.symbols, imports: indexedSymbols.imports });

		expect(edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "imports", from: "file:src/main.c", to: "file:src/local.h", lexicalTarget: "local.h", importKind: "relative" }),
			expect.objectContaining({ kind: "imports", from: "file:src/main.cpp", to: "file:src/header.hpp", lexicalTarget: "header", importKind: "relative" }),
			expect.objectContaining({ kind: "imports", from: "file:src/main.cpp", to: "external:stdio.h", lexicalTarget: "stdio.h", importKind: "external" }),
		]));
		expect(edges).not.toContainEqual(expect.objectContaining({ kind: "imports", from: "file:src/main.cpp", to: "file:src/stdio.h" }));

		const reused = await indexRepoMapSymbols({
			root,
			files,
			concurrency: 1,
			readText: readSources(sources),
			previous: { files, symbols: indexedSymbols.symbols, edges, diagnostics: [] },
		});
		expect(reused.imports).toEqual(indexedSymbols.imports);
		expect(buildRepoMapRelationships({ mapId: "g".repeat(64), files, symbols: reused.symbols, imports: reused.imports }))
			.toEqual(edges);
	});

	it("creates export edges for every exported variable declarator", async () => {
		const text = "export const first = 1, second = 2;\nexport let third = 3;\n";
		const sources = new Map([["values.ts", text]]);
		const files = [indexed("values.ts", text)];
		const result = await indexRepoMapSymbols({ root, files, concurrency: 1, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "d".repeat(64), files, symbols: result.symbols, imports: result.imports });
		const exportedIds = new Set(edges.filter((edge) => edge.kind === "exports").map((edge) => edge.to));

		expect(result.symbols.map((symbol) => symbol.name)).toEqual(["first", "second", "third"]);
		expect(exportedIds).toEqual(new Set(result.symbols.map((symbol) => symbol.id)));
	});

	it("creates an export relation for a local named export without exposing unrelated declarations", async () => {
		const text = "const internal = 1;\nconst exposed = 2;\nexport { exposed };\n";
		const sources = new Map([["values.ts", text]]);
		const files = [indexed("values.ts", text)];
		const result = await indexRepoMapSymbols({ root, files, concurrency: 1, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "h".repeat(64), files, symbols: result.symbols, imports: result.imports });
		const symbolsByName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
		const exposed = symbolsByName.get("exposed");
		const internal = symbolsByName.get("internal");
		if (exposed === undefined || internal === undefined) throw new Error("missing local declarations");

		expect(exposed.exported).toBe(true);
		expect(internal.exported).toBe(false);
		expect(edges.filter((edge) => edge.kind === "exports").map((edge) => edge.to)).toEqual([exposed.id]);
	});

	it.each([
		["api.c", "int external_api(void) { return 1; }\nstatic int internal_helper(void) { return 2; }\n"],
		["api.cpp", "int external_api() { return 1; }\nstatic int internal_helper() { return 2; }\n"],
	])("distinguishes external and internal linkage exports in %s", async (filePath, text) => {
		const sources = new Map([[filePath, text]]);
		const files = [indexed(filePath, text)];
		const result = await indexRepoMapSymbols({ root, files, concurrency: 1, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "i".repeat(64), files, symbols: result.symbols, imports: result.imports });
		const symbolsByName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
		const external = symbolsByName.get("external_api");
		const internal = symbolsByName.get("internal_helper");
		if (external === undefined || internal === undefined) throw new Error("missing linkage declarations");

		expect(external.exported).toBe(true);
		expect(internal.exported).toBe(false);
		expect(edges.filter((edge) => edge.kind === "exports").map((edge) => edge.to)).toEqual([external.id]);
	});

	it.each([
		["from .worker import run", ".worker"],
		["from pkg.worker import run", "pkg.worker"],
	])("resolves a repository-local Python import: %s", async (statement, lexicalTarget) => {
		const sources = new Map([
			["pkg/main.py", `${statement}\n`],
			["pkg/worker.py", "def run():\n  pass\n"],
		]);
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const result = await indexRepoMapSymbols({ root, files, concurrency: 1, readText: readSources(sources) });
		const edges = buildRepoMapRelationships({ mapId: "j".repeat(64), files, symbols: result.symbols, imports: result.imports });

		expect(edges).toContainEqual(expect.objectContaining({
			kind: "imports",
			from: "file:pkg/main.py",
			to: "file:pkg/worker.py",
			lexicalTarget,
			resolution: "syntactic",
		}));
	});

	it("incrementally reuses stable relations and invalidates callers when the symbol lookup changes", async () => {
		const firstSources = new Map([
			["a.ts", "export function caller() { return target(); }\n"],
			["b.ts", "export function target() {}\n"],
			["stable.ts", "export function stable() {}\nexport function stableCaller() { return stable(); }\n"],
		]);
		const previousFiles = [...firstSources].map(([filePath, text]) => indexed(filePath, text));
		const previousIndex = await indexRepoMapSymbols({ root, files: previousFiles, concurrency: 2, readText: readSources(firstSources) });
		const previousEdges = buildRepoMapRelationships({ mapId: "c".repeat(64), files: previousFiles, symbols: previousIndex.symbols, imports: previousIndex.imports });
		const sources = new Map(firstSources);
		sources.set("b.ts", "export function replacement() {}\n");
		const files = [...sources].map(([filePath, text]) => indexed(filePath, text));
		const currentIndex = await indexRepoMapSymbols({ root, files, concurrency: 2, readText: readSources(sources) });
		const incremental = buildRepoMapRelationships({
			mapId: "c".repeat(64),
			files,
			symbols: currentIndex.symbols,
			imports: currentIndex.imports,
			previous: { files: previousFiles, symbols: previousIndex.symbols, edges: previousEdges },
		});
		const rebuilt = buildRepoMapRelationships({ mapId: "c".repeat(64), files, symbols: currentIndex.symbols, imports: currentIndex.imports });

		expect(incremental).toEqual(rebuilt);
		expect(incremental).toContainEqual(expect.objectContaining({ kind: "calls", lexicalTarget: "target", to: "lexical:symbol:target" }));
	});
});

function indexed(filePath: string, text: string): RepoMapFileRecord {
	return {
		id: `file:${filePath}`,
		path: filePath,
		size: Buffer.byteLength(text),
		mtimeMs: 1,
		status: "indexed",
		contentHash: createHash("sha256").update(text).digest("hex"),
	};
}

function readSources(sources: ReadonlyMap<string, string>): (absolutePath: string) => Promise<string> {
	return async (absolutePath) => {
		const text = sources.get(path.relative(root, absolutePath).replaceAll(path.sep, "/"));
		if (text === undefined) throw new Error("missing fixture");
		return text;
	};
}
