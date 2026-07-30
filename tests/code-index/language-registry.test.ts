import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import {
	adapterFromPath,
	createLanguageRegistry,
	getLanguageAdapter,
	languageFromPath,
	registeredLanguageAdapters,
} from "../../src/code-index/language-registry.js";
import {
	disposeTreeSitterParserCache,
	loadTreeSitterParser,
	loadTreeSitterRuntime,
} from "../../src/syntax-tree/loader.js";
import { parseDocument, parseDocumentForAdapter } from "../../src/code-index/syntax-tree.js";
import type { LanguageAdapter } from "../../src/code-index/adapters/types.js";
import { treeSitterModulePaths } from "../helpers/tree-sitter-dependencies.js";

const require = createRequire(import.meta.url);
const grammarModules = treeSitterModulePaths().filter((modulePath) => !modulePath.includes("web-tree-sitter"));

afterAll(() => disposeTreeSitterParserCache());

describe("code language registry", () => {
	it("registers every supported language without loading grammar JavaScript modules", () => {
		expect(registeredLanguageAdapters().map((adapter) => adapter.language)).toEqual([
			"javascript", "jsx", "typescript", "tsx", "python", "go", "rust", "c", "cpp",
		]);
		for (const modulePath of grammarModules) expect(require.cache[modulePath]).toBeUndefined();
	});

	it.each([
		["src/feature.TS", "typescript", ".ts"],
		["src/component.JSX", "jsx", ".jsx"],
		["src/main.MJS", "javascript", ".mjs"],
		["src/worker.PY", "python", ".py"],
		["src/service.GO", "go", ".go"],
		["src/lib.RS", "rust", ".rs"],
		["src/main.C", "c", ".c"],
		["include/api.H", "cpp", ".h"],
		["src/main.CPP", "cpp", ".cpp"],
	] as const)("maps %s through the prebuilt extension map", (filePath, language, extension) => {
		expect(languageFromPath(filePath)).toBe(language);
		expect(adapterFromPath(filePath)).toMatchObject({ language, extensions: expect.arrayContaining([extension]) });
	});

	it("loads C/C++ WebAssembly grammars without requiring their native modules", async () => {
		const c = await parseDocument("c", "int value;\n");
		expect(c).toBeDefined();
		c?.dispose();
		expect(require.cache[require.resolve("tree-sitter-c")]).toBeUndefined();
		expect(require.cache[require.resolve("tree-sitter-cpp")]).toBeUndefined();

		const cpp = await parseDocument("cpp", "class Value {};\n");
		expect(cpp).toBeDefined();
		cpp?.dispose();
		expect(require.cache[require.resolve("tree-sitter-cpp")]).toBeUndefined();
	});

	it("returns text for unregistered extensions and no adapter for text", () => {
		expect(languageFromPath("src/module.rb")).toBe("text");
		expect(getLanguageAdapter("text")).toBeUndefined();
	});

	it("registers extension metadata in an isolated registry and loads its WASM descriptor", async () => {
		const simulated: LanguageAdapter = { ...javascriptAdapter, extensions: [".simulated"] };
		const registry = createLanguageRegistry([simulated]);
		expect(registry.languageFromPath("new.simulated")).toBe("javascript");
		expect(registry.adapterFromPath("new.simulated")).toBe(simulated);
		expect(await loadTreeSitterRuntime(simulated.grammar)).toHaveProperty("runtime");
	});

	it("returns stable structured failures and retries stale failure caches", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
		try {
			const missingSpec = { packageName: "tree-sitter-typescript", wasmFile: "missing.wasm" };
			const first = loadTreeSitterRuntime(missingSpec);
			expect(loadTreeSitterRuntime(missingSpec)).toBe(first);
			expect(await first).toEqual({ failure: { code: "GRAMMAR_UNAVAILABLE", message: expect.stringContaining("tree-sitter-typescript/missing.wasm") } });
			expect(loadTreeSitterRuntime(missingSpec)).toBe(first);

			clock.mockReturnValue(70_000);
			const retried = loadTreeSitterRuntime(missingSpec);
			expect(retried).not.toBe(first);
			expect(await retried).toEqual({ failure: { code: "GRAMMAR_UNAVAILABLE", message: expect.stringContaining("tree-sitter-typescript/missing.wasm") } });

			const incompatible = await loadTreeSitterRuntime({ packageName: "tree-sitter-typescript", wasmFile: "package.json" });
			expect(incompatible).toEqual({ failure: { code: "GRAMMAR_INCOMPATIBLE", message: expect.stringContaining("tree-sitter-typescript/package.json") } });
		} finally {
			clock.mockRestore();
		}
	});

	it("reuses a parser after timeout and replaces it after an exception", async () => {
		const first = await loadTreeSitterParser(javascriptAdapter.grammar);
		const second = await loadTreeSitterParser(javascriptAdapter.grammar);
		if (!("parser" in first) || !("parser" in second)) throw new Error("javascript parser unavailable");
		expect(second.parser).toBe(first.parser);
		const originalParse = first.parser.parse.bind(first.parser);
		const parseSpy = vi.spyOn(first.parser, "parse")
			.mockImplementationOnce(() => null)
			.mockImplementationOnce(originalParse)
			.mockImplementationOnce(() => { throw new Error("simulated parser exception"); })
			.mockImplementation(originalParse);
		try {
			expect(await parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n")).toEqual({ failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." } });
			const recovered = await parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n");
			expect(recovered.document).toBeDefined();
			recovered.document?.dispose();
			expect(await parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n")).toEqual({ failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the source." } });
			const replacement = await loadTreeSitterParser(javascriptAdapter.grammar);
			if (!("parser" in replacement)) throw new Error("replacement javascript parser unavailable");
			expect(replacement.parser).not.toBe(first.parser);
			const recoveredAgain = await parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n");
			expect(recoveredAgain.document).toBeDefined();
			recoveredAgain.document?.dispose();
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("cancels a real parse through the runtime progress callback and remains reusable", async () => {
		const text = Array.from({ length: 5_000 }, (_, index) => `const value${index} = ${index};`).join("\n");
		expect(await parseDocumentForAdapter(javascriptAdapter, text, 0)).toEqual({
			failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." },
		});
		const recovered = await parseDocumentForAdapter(javascriptAdapter, "const value = 1;\n");
		expect(recovered.document).toBeDefined();
		recovered.document?.dispose();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])("normalizes non-finite timeout %s to the default deadline", async (timeoutMicros) => {
		const parserResult = await loadTreeSitterParser(javascriptAdapter.grammar);
		if (!("parser" in parserResult)) throw new Error("javascript parser unavailable");
		let now = 100;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		const parseSpy = vi.spyOn(parserResult.parser, "parse").mockImplementation((_input, _oldTree, options) => {
			now = 351;
			expect(options?.progressCallback?.({ currentOffset: 0, hasError: false })).toBe(true);
			return null;
		});
		try {
			expect(await parseDocumentForAdapter(javascriptAdapter, "const value = 1;\n", timeoutMicros)).toEqual({
				failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." },
			});
		} finally {
			parseSpy.mockRestore();
			clock.mockRestore();
		}
	});

	it("deletes a created tree and replaces its parser when document construction throws", async () => {
		const parserResult = await loadTreeSitterParser(javascriptAdapter.grammar);
		if (!("parser" in parserResult)) throw new Error("javascript parser unavailable");
		const parser = parserResult.parser;
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
			expect(await parseDocumentForAdapter(javascriptAdapter, "const value = 1;\n")).toEqual({
				failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the source." },
			});
			expect(deleted).toBe(true);
			const replacement = await loadTreeSitterParser(javascriptAdapter.grammar);
			if (!("parser" in replacement)) throw new Error("replacement javascript parser unavailable");
			expect(replacement.parser).not.toBe(parser);
		} finally {
			parseSpy.mockRestore();
		}
	});
});
