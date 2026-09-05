import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { languageFromPath } from "../../src/syntax-tree/grammars.js";
import { treeSitterModulePaths } from "../helpers/tree-sitter-dependencies.js";

const require = createRequire(import.meta.url);

describe("code language discovery", () => {
	it.each([
		["scripts/deploy.SH", "bash"],
		["src/feature.TS", "typescript"],
		["src/component.JSX", "jsx"],
		["src/component.tsx", "tsx"],
		["src/main.MJS", "javascript"],
		["src/worker.PY", "python"],
		["src/service.GO", "go"],
		["src/lib.RS", "rust"],
		["src/main.C", "c"],
		["include/api.H", "cpp"],
		["src/main.CPP", "cpp"],
		["src\\feature.TS", "typescript"],
		[".ts", "typescript"],
		["parent.ts/notes", "text"],
		["src/module.rb", "text"],
	] as const)("%s -> %s", (filePath, language) => {
		expect(languageFromPath(filePath)).toBe(language);
	});

	it("语言发现不加载 native grammar 模块", () => {
		for (const modulePath of treeSitterModulePaths().filter((value) => !value.includes("web-tree-sitter"))) {
			expect(require.cache[modulePath]).toBeUndefined();
		}
	});
});
