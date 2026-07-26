import { describe, expect, it } from "vitest";

import { analyzeCodeFile } from "../../src/code-index/parser.js";
import { parseDocument } from "../../src/code-index/syntax-tree.js";
import { javascriptSyntaxFacts } from "../../src/repo-map/indexing/syntax-facts.js";

const EMPTY_FACTS = {
	registrations: [],
	reExports: [],
	defaultExports: [],
	tests: [],
	mocks: [],
	fixtures: [],
	snapshots: [],
};

describe("shared syntax tree boundary", () => {
	it("creates an owned syntax tree without exposing Parser initialization to callers", async () => {
		const document = await parseDocument("typescript", "export function run() {}\n");
		if (document === undefined) throw new Error("missing syntax tree");
		try {
			expect(document.root.type).toBe("program");
			expect(document.root.hasError).toBe(false);
		} finally {
			document.dispose();
		}
	});

	it("keeps code parser syntax-error tolerance separate from syntax-facts strictness", async () => {
		const malformed = "export function run() {\n";
		const document = await parseDocument("typescript", malformed);
		if (document === undefined) throw new Error("missing syntax tree");
		try {
			expect(document.root.hasError).toBe(true);
		} finally {
			document.dispose();
		}
		expect((await analyzeCodeFile("broken.ts", malformed)).status).toBe("parsed");
		expect(await javascriptSyntaxFacts("broken.ts", malformed)).toEqual(EMPTY_FACTS);
	});

	it("extracts valid JavaScript-family facts through the shared tree", async () => {
		const facts = await javascriptSyntaxFacts("extension.ts", 'registerCommand("demo", () => {});\n');
		expect(facts.registrations).toEqual([expect.objectContaining({ name: "demo", type: "command", dynamic: false })]);
	});

	it("extracts facts from a deeply nested member chain without using the JavaScript call stack", async () => {
		const text = `vi${".layer".repeat(2_500)}.mock("dependency");\n`;
		const facts = await javascriptSyntaxFacts("deep.test.ts", text);
		expect(facts.mocks).toEqual([expect.objectContaining({ name: "dependency" })]);
	});

	it("reports UTF-8 byte ranges for every JavaScript-family fact after non-ASCII text", async () => {
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
		const facts = await javascriptSyntaxFacts("extension.test.ts", text);
		expect(facts.registrations[0]?.startByte).toBe(Buffer.byteLength("// 你😀\n", "utf8"));
		const snippets = [
			[facts.registrations[0], "registerCommand"],
			[facts.reExports[0], "export { value }"],
			[facts.defaultExports[0], "export default"],
			[facts.tests[0], 'test("works"'],
			[facts.mocks[0], "vi.mock"],
			[facts.fixtures[0], '"./fixtures/data.json"'],
			[facts.snapshots[0], "toMatchSnapshot"],
		] as const;

		for (const [fact, snippet] of snippets) {
			if (fact === undefined) throw new Error(`missing syntax fact for ${snippet}`);
			expect(Buffer.from(text, "utf8").subarray(fact.startByte, fact.endByte).toString("utf8")).toContain(snippet);
		}
	});
});
