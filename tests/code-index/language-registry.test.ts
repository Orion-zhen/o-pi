import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
	adapterFromPath,
	getLanguageAdapter,
	languageFromPath,
	registeredLanguageAdapters,
} from "../../src/code-index/language-registry.js";
import { loadGrammar, loadTreeSitterRuntime } from "../../src/code-index/tree-sitter-loader.js";
import type { CodeLanguage } from "../../src/code-index/types.js";

const require = createRequire(import.meta.url);
const grammarModules = [
	require.resolve("tree-sitter"),
	require.resolve("tree-sitter-javascript"),
	require.resolve("tree-sitter-typescript"),
	require.resolve("tree-sitter-python"),
	require.resolve("tree-sitter-go"),
	require.resolve("tree-sitter-rust"),
];

describe("code language registry", () => {
	it("registers every supported language without loading grammar modules", () => {
		expect(registeredLanguageAdapters().map((adapter) => adapter.language)).toEqual([
			"javascript", "jsx", "typescript", "tsx", "python", "go", "rust",
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
	] as const)("maps %s through the prebuilt extension map", (filePath, language, extension) => {
		expect(languageFromPath(filePath)).toBe(language);
		expect(adapterFromPath(filePath)).toMatchObject({ language, extensions: expect.arrayContaining([extension]) });
	});

	it("returns text for unregistered extensions and no adapter for text", () => {
		expect(languageFromPath("src/module.rb")).toBe("text");
		expect(getLanguageAdapter("text")).toBeUndefined();
		expect(loadTreeSitterRuntime("text")).toBeUndefined();
	});

	it("does not accept a missing or wrong grammar export", () => {
		expect(loadGrammar({ packageName: "tree-sitter-typescript", exportName: "missing" })).toBeUndefined();
		expect(loadGrammar({ packageName: "tree-sitter-rust", exportName: "language" })).toBeUndefined();
		expect(loadGrammar({ packageName: "package-that-does-not-exist" })).toBeUndefined();
		expect(loadTreeSitterRuntime("ruby" as CodeLanguage)).toBeUndefined();
	});
});
