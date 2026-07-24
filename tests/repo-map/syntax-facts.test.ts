import { describe, expect, it } from "vitest";

import { analyzeCodeFile } from "../../src/code-index/parser.js";
import { parseSyntaxTree } from "../../src/code-index/syntax-tree.js";
import { javascriptSyntaxFacts } from "../../src/repo-map/syntax-facts.js";

describe("shared syntax tree boundary", () => {
	it("creates a syntax tree without exposing Parser initialization to callers", () => {
		const root = parseSyntaxTree("typescript", "export function run() {}\n");
		if (root === undefined) throw new Error("missing syntax tree");
		expect(root.type).toBe("program");
		expect(root.hasError).toBe(false);
	});

	it("keeps code parser syntax-error tolerance separate from syntax-facts strictness", () => {
		const malformed = "export function run() {\n";
		const root = parseSyntaxTree("typescript", malformed);
		if (root === undefined) throw new Error("missing syntax tree");
		expect(root.hasError).toBe(true);
		expect(analyzeCodeFile("broken.ts", malformed).status).toBe("parsed");
		expect(javascriptSyntaxFacts("broken.ts", malformed)).toEqual({
			registrations: [],
			reExports: [],
			defaultExports: [],
			tests: [],
			mocks: [],
			fixtures: [],
			snapshots: [],
		});
	});

	it("extracts valid JavaScript-family facts through the shared tree", () => {
		const facts = javascriptSyntaxFacts("extension.ts", 'registerCommand("demo", () => {});\n');
		expect(facts.registrations).toEqual([expect.objectContaining({ name: "demo", type: "command", dynamic: false })]);
	});
});
