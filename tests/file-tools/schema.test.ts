import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import fileTools from "../../agent/extensions/file-tools.js";

interface RegisteredTool {
	parameters: AnySchema;
	prepareArguments?: (args: unknown) => unknown;
}

function registeredTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	fileTools({
		registerTool(tool: { name: string } & RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on() {},
	} as never);
	return tools;
}

function validates(schema: AnySchema, value: unknown): boolean {
	const ajv = new Ajv({ strict: false });
	return ajv.compile(schema)(value) === true;
}

describe("file tool schemas", () => {
	it("使用整数范围、数组长度、必填字段和未知字段限制", () => {
		const tools = registeredTools();
		const ls = tools.get("ls")?.parameters;
		const findTool = tools.get("find");
		const find = findTool?.parameters;
		const grepTool = tools.get("grep");
		const grep = grepTool?.parameters;
		const read = tools.get("read")?.parameters;
		const edit = tools.get("edit")?.parameters;
		if (ls === undefined || find === undefined || grep === undefined || read === undefined || edit === undefined || findTool === undefined || grepTool === undefined) throw new Error("missing tool schema");

		expect(validates(ls, {})).toBe(true);
		expect(validates(ls, { path: "src" })).toBe(true);
		expect(validates(ls, { path: "" })).toBe(false);
		expect(validates(ls, { extra: true })).toBe(false);

		expect(validates(find, { query: "auth service" })).toBe(true);
		expect(validates(find, { query: "**/*.ts", path: ["src"] })).toBe(true);
		expect(validates(find, { query: "**/*.ts", path: ["src", "tests"] })).toBe(true);
		expect(validates(find, { query: "**/*.ts", path: [] })).toBe(false);
		expect(validates(find, { query: "**/*.ts", path: "src" })).toBe(false);
		expect(validates(find, { query: "" })).toBe(false);
		expect(validates(find, { query: "x", glob: "**/*.ts" })).toBe(false);
		expect(validates(find, { pattern: "**/*.ts" })).toBe(false);
		expect(validates(find, { query: "x", mode: "name" })).toBe(false);
		expect(validates(find, { query: "x", limit: 20 })).toBe(false);
		expect(findTool.prepareArguments?.({ query: "x", path: "src tests" })).toEqual({ query: "x", path: ["src", "tests"] });
		expect(findTool.prepareArguments?.({ query: "x", path: ["src", "tests"] })).toEqual({ query: "x", path: ["src", "tests"] });

		expect(validates(grep, { query: "x" })).toBe(true);
		expect(validates(grep, { query: "x", path: ["."], match: "auto", glob: "**/*.ts" })).toBe(true);
		expect(validates(grep, { query: "x", path: ["src", "tests"] })).toBe(true);
		expect(validates(grep, { query: "x", path: [] })).toBe(false);
		expect(validates(grep, { query: "x", path: "." })).toBe(false);
		expect(validates(grep, { query: "x", match: "literal" })).toBe(true);
		expect(validates(grep, { query: "x", match: "regex" })).toBe(true);
		expect(validates(grep, { query: "" })).toBe(false);
		expect(validates(grep, { query: "x", match: "content" })).toBe(false);
		expect(validates(grep, { query: "x", mode: "content" })).toBe(false);
		expect(validates(grep, { query: "x", regex: true })).toBe(false);
		expect(validates(grep, { query: "x", context: 1 })).toBe(false);
		expect(validates(grep, { query: "x", limit: 20 })).toBe(false);
		expect(validates(grep, { query: "x", ignore_case: true })).toBe(false);
		expect(validates(grep, { query: "x", extra: true })).toBe(false);
		expect(grepTool.prepareArguments?.({ query: "x", path: "src,tests" })).toEqual({ query: "x", path: ["src", "tests"] });

		expect(validates(read, { path: "a.ts", start_line: 1, end_line: 2 })).toBe(true);
		expect(validates(read, { path: "a.ts", start_line: 1.5 })).toBe(false);

		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y" }] })).toBe(true);
		expect(validates(edit, { path: "a.ts", edits: [] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "", new: "y" }] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y", extra: true }] })).toBe(false);
	});
});
