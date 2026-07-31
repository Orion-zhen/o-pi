import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

import { TREE_SITTER_GRAMMARS } from "../../src/syntax-tree/grammars.js";
import { disposeTreeSitterParserCache, loadTreeSitterParser } from "../../src/syntax-tree/loader.js";
import { parseSyntaxTree } from "../../src/syntax-tree/parser.js";

const require = createRequire(import.meta.url);

afterAll(() => disposeTreeSitterParserCache());

describe("shared syntax tree parser", () => {
	it("通过统一 grammar catalog 加载 Bash WASM，不加载 native module", async () => {
		const parsed = await parseSyntaxTree(
			TREE_SITTER_GRAMMARS.bash,
			"echo ready && git push origin main > result.log",
		);
		expect(parsed.failure).toBeUndefined();
		expect(parsed.document?.root.type).toBe("program");
		expect(parsed.document?.root.descendantsOfType("command").map((node) => node.text)).toEqual([
			"echo ready",
			"git push origin main",
		]);
		parsed.document?.dispose();
		expect(require.cache[require.resolve("tree-sitter-bash")]).toBeUndefined();
	});

	it("不同 grammar 共用 loader，并分别缓存 parser", async () => {
		const bashFirst = await loadTreeSitterParser(TREE_SITTER_GRAMMARS.bash);
		const bashSecond = await loadTreeSitterParser(TREE_SITTER_GRAMMARS.bash);
		const javascript = await loadTreeSitterParser(TREE_SITTER_GRAMMARS.javascript);
		if (!("parser" in bashFirst) || !("parser" in bashSecond) || !("parser" in javascript)) {
			throw new Error("Tree-sitter parser unavailable");
		}
		expect(bashSecond.parser).toBe(bashFirst.parser);
		expect(javascript.parser).not.toBe(bashFirst.parser);
	});
});
