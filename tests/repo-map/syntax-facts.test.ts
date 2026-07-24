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

	it("reports UTF-8 byte ranges for every JavaScript-family fact after non-ASCII text", () => {
		const text = [
			"// 你😀",
			'registerCommand("demo", () => {});',
			'export { value } from "./value";',
			"export default {};",
			'test("works", () => {});',
			'vi.mock("./dependency");',
			'const fixture = "./fixtures/data.json";',
			"expect(value).toMatchSnapshot();",
			"",
		].join("\n");
		const facts = javascriptSyntaxFacts("extension.test.ts", text);
		expect(facts.registrations[0]?.startByte).toBe(Buffer.byteLength("// 你😀\n", "utf8"));
		const snippets = [
			[facts.registrations[0], "registerCommand"],
			[facts.reExports[0], "export { value }"],
			[facts.defaultExports[0], "export default"],
			[facts.tests[0], "test(\"works\""],
			[facts.mocks[0], "vi.mock"],
			[facts.fixtures[0], "\"./fixtures/data.json\""],
			[facts.snapshots[0], "toMatchSnapshot"],
		] as const;

		for (const [fact, snippet] of snippets) {
			if (fact === undefined) throw new Error(`missing syntax fact for ${snippet}`);
			expect(Buffer.from(text, "utf8").subarray(fact.startByte, fact.endByte).toString("utf8")).toContain(snippet);
		}
	});
});
