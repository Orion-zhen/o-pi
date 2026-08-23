import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
	adapterFromPath,
	getLanguageAdapter,
	LANGUAGE_ADAPTERS,
	languageFromPath,
} from "../../src/code-index/language-registry.js";
import { TREE_SITTER_LANGUAGES } from "../../src/syntax-tree/grammars.js";
import { treeSitterModulePaths } from "../helpers/tree-sitter-dependencies.js";

const require = createRequire(import.meta.url);
const grammarModules = treeSitterModulePaths().filter((modulePath) => !modulePath.includes("web-tree-sitter"));

describe("code language registry", () => {
	it("registers every supported language without loading grammar JavaScript modules", () => {
		const languages = LANGUAGE_ADAPTERS.map((adapter) => adapter.language);
		expect(languages).toEqual(TREE_SITTER_LANGUAGES.map((spec) => spec.language));
		expect(languages).toEqual([
			"javascript", "jsx", "typescript", "tsx", "python", "go", "rust", "c", "cpp", "bash",
		]);
		for (const [index, adapter] of LANGUAGE_ADAPTERS.entries()) {
			const spec = TREE_SITTER_LANGUAGES[index];
			expect(adapter.extensions).toBe(spec?.extensions);
			expect(adapter.grammar).toBe(spec?.grammar);
			expect(getLanguageAdapter(adapter.language)).toBe(adapter);
			expect(adapter.extractUnits).toEqual(expect.any(Function));
			expect(adapter.extractImports).toEqual(expect.any(Function));
		}
		for (const modulePath of grammarModules) expect(require.cache[modulePath]).toBeUndefined();
	});

	it.each([
		["scripts/deploy.SH", "bash", ".sh"],
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

	it("returns text for unregistered extensions and no adapter for text", () => {
		expect(languageFromPath("src/module.rb")).toBe("text");
		expect(getLanguageAdapter("text")).toBeUndefined();
	});
});
