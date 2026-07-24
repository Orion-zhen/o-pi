import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import {
	adapterFromPath,
	createLanguageRegistry,
	getLanguageAdapter,
	languageFromPath,
	registeredLanguageAdapters,
} from "../../src/code-index/language-registry.js";
import { loadGrammar, loadTreeSitterParser, loadTreeSitterRuntime, loadTreeSitterRuntimeForGrammar } from "../../src/code-index/tree-sitter-loader.js";
import { parseDocumentForAdapter, parseSyntaxTree } from "../../src/code-index/syntax-tree.js";
import type { LanguageAdapter } from "../../src/code-index/adapters/types.js";
import type { CodeLanguage } from "../../src/code-index/types.js";

const require = createRequire(import.meta.url);
const grammarModules = [
	require.resolve("tree-sitter"),
	require.resolve("tree-sitter-javascript"),
	require.resolve("tree-sitter-typescript"),
	require.resolve("tree-sitter-python"),
	require.resolve("tree-sitter-go"),
	require.resolve("tree-sitter-rust"),
	require.resolve("tree-sitter-c"),
	require.resolve("tree-sitter-cpp"),
];

describe("code language registry", () => {
	it("registers every supported language without loading grammar modules", () => {
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

	it("loads only the requested C/C++ grammar on first parse", () => {
		expect(parseSyntaxTree("c", "int value;\n")).toBeDefined();
		expect(require.cache[require.resolve("tree-sitter-c")]).toBeDefined();
		expect(require.cache[require.resolve("tree-sitter-cpp")]).toBeUndefined();

		expect(parseSyntaxTree("cpp", "class Value {};\n")).toBeDefined();
		expect(require.cache[require.resolve("tree-sitter-cpp")]).toBeDefined();
	});

	it("returns text for unregistered extensions and no adapter for text", () => {
		expect(languageFromPath("src/module.rb")).toBe("text");
		expect(getLanguageAdapter("text")).toBeUndefined();
		expect(loadTreeSitterRuntime("text")).toBeUndefined();
	});

	it("registers extension metadata in an isolated registry and loads its grammar descriptor", () => {
		const simulated: LanguageAdapter = { ...javascriptAdapter, extensions: [".simulated"] };
		const registry = createLanguageRegistry([simulated]);
		expect(registry.languageFromPath("new.simulated")).toBe("javascript");
		expect(registry.adapterFromPath("new.simulated")).toBe(simulated);
		expect(loadGrammar(simulated.grammar)).toBeDefined();
	});

	it("returns stable structured failures for missing and wrong grammar descriptors", () => {
		const wrong = loadTreeSitterRuntimeForGrammar({ packageName: "tree-sitter-typescript", exportName: "missing" });
		expect(wrong).toEqual({ failure: { code: "GRAMMAR_EXPORT_INVALID", message: expect.stringContaining("tree-sitter-typescript:missing") } });
		expect(loadTreeSitterRuntimeForGrammar({ packageName: "tree-sitter-typescript", exportName: "missing" })).toBe(wrong);
		const missing = loadTreeSitterRuntimeForGrammar({ packageName: "package-that-does-not-exist" });
		expect(missing).toEqual({ failure: { code: "GRAMMAR_UNAVAILABLE", message: expect.stringContaining("package-that-does-not-exist") } });
		expect(loadGrammar({ packageName: "tree-sitter-rust", exportName: "language" })).toBeUndefined();
		expect(loadTreeSitterRuntime("ruby" as CodeLanguage)).toBeUndefined();
	});

	it("reuses a parser per descriptor and resets after a timeout", () => {
		const first = loadTreeSitterParser(javascriptAdapter);
		const second = loadTreeSitterParser(javascriptAdapter);
		if (!("parser" in first) || !("parser" in second)) throw new Error("javascript parser unavailable");
		expect(second.parser).toBe(first.parser);
		const timeoutParser = loadTreeSitterParser(javascriptAdapter, 1);
		if (!("parser" in timeoutParser)) throw new Error("timeout parser unavailable");
		const originalParse = timeoutParser.parser.parse.bind(timeoutParser.parser);
		const parseSpy = vi.spyOn(timeoutParser.parser, "parse")
			.mockImplementationOnce(() => null as never)
			.mockImplementationOnce(originalParse)
			.mockImplementationOnce(() => { throw new Error("simulated parser exception"); })
			.mockImplementation(originalParse);
		try {
			const timeout = parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n", 1);
			expect(timeout).toEqual({ failure: { code: "PARSER_TIMEOUT", message: "Tree-sitter parsing exceeded the configured timeout." } });
			expect(parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n", 1).document).toBeDefined();
			expect(parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n", 1)).toEqual({ failure: { code: "PARSER_EXCEPTION", message: "Tree-sitter raised an exception while parsing the file." } });
			expect(parseDocumentForAdapter(javascriptAdapter, "function value() { return 1; }\n", 1).document).toBeDefined();
		} finally {
			parseSpy.mockRestore();
		}
	});

});
