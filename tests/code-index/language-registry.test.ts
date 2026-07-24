import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { javascriptAdapter } from "../../src/code-index/adapters/javascript.js";
import {
	adapterFromPath,
	createLanguageRegistry,
	getLanguageAdapter,
	languageFromPath,
	registeredLanguageAdapters,
} from "../../src/code-index/language-registry.js";
import { loadGrammar, loadTreeSitterRuntime } from "../../src/code-index/tree-sitter-loader.js";
import { parseSyntaxTree } from "../../src/code-index/syntax-tree.js";
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

	it("does not accept a missing or wrong grammar export", () => {
		expect(loadGrammar({ packageName: "tree-sitter-typescript", exportName: "missing" })).toBeUndefined();
		expect(loadGrammar({ packageName: "tree-sitter-rust", exportName: "language" })).toBeUndefined();
		expect(loadGrammar({ packageName: "package-that-does-not-exist" })).toBeUndefined();
		expect(loadTreeSitterRuntime("ruby" as CodeLanguage)).toBeUndefined();
	});
});
