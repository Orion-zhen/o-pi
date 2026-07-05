import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import fileTools from "../agent/extensions/file-tools.js";

function registeredTools(): Map<string, { parameters: unknown }> {
	const tools = new Map<string, { parameters: unknown }>();
	fileTools({
		registerTool(tool: { name: string; parameters: unknown }) {
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
		const find = tools.get("find")?.parameters as AnySchema | undefined;
		const grep = tools.get("grep")?.parameters as AnySchema | undefined;
		const read = tools.get("read")?.parameters as AnySchema | undefined;
		const edit = tools.get("edit")?.parameters as AnySchema | undefined;
		if (find === undefined || grep === undefined || read === undefined || edit === undefined) throw new Error("missing tool schema");

		expect(validates(find, { query: "auth service" })).toBe(true);
		expect(validates(find, { query: "**/*.ts", path: "src" })).toBe(true);
		expect(validates(find, { query: "" })).toBe(false);
		expect(validates(find, { pattern: "**/*.ts" })).toBe(false);
		expect(validates(find, { query: "x", mode: "name" })).toBe(false);
		expect(validates(find, { query: "x", limit: 20 })).toBe(false);

		expect(validates(grep, { query: "x" })).toBe(true);
		expect(validates(grep, { query: "x", path: ".", match: "auto", glob: "**/*.ts" })).toBe(true);
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

		expect(validates(read, { path: "a.ts", start_line: 1, end_line: 2 })).toBe(true);
		expect(validates(read, { path: "a.ts", start_line: 1.5 })).toBe(false);

		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y" }] })).toBe(true);
		expect(validates(edit, { path: "a.ts", edits: [] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "", new: "y" }] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y", extra: true }] })).toBe(false);
	});
});
