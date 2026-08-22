import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";

interface RegisteredTool {
	parameters: AnySchema;
	prepareArguments?: (args: unknown) => unknown;
}

const tools = new Map<string, RegisteredTool>();
fileTools({
	registerTool(tool: { name: string } & RegisteredTool) {
		tools.set(tool.name, tool);
	},
	on() {},
} as never);
const ajv = new Ajv({ strict: false });

function validate(toolName: string, value: unknown): boolean {
	const schema = tools.get(toolName)?.parameters;
	if (schema === undefined) throw new Error(`missing ${toolName} schema`);
	return ajv.compile(schema)(value) === true;
}

const schemaCases = [
	{
		tool: "ls",
		valid: [{}, { path: "src" }],
		invalid: [{ path: "" }, { extra: true }],
	},
	{
		tool: "find",
		valid: [
			{ query: "auth service" },
			{ query: "auth", path: ["src", "tests"], glob: "**/*.ts" },
		],
		invalid: [
			{ query: "" },
			{ query: "x".repeat(513) },
			{ query: "x", path: [] },
			{ query: "x", path: "src" },
			{ query: "x", glob: "" },
			{ query: "x", extra: true },
		],
	},
	{
		tool: "grep",
		valid: [
			{ query: "x" },
			{ query: "x", path: ["src", "tests"], glob: "**/*.ts" },
		],
		invalid: [
			{ query: "" },
			{ query: "x", path: [] },
			{ query: "x", path: "." },
			{ query: "x", match: "auto" },
			{ query: "x", extra: true },
		],
	},
	{
		tool: "read",
		valid: [{ path: "a.ts", start_line: 1, end_line: 2 }],
		invalid: [
			{ path: "a.ts", start_line: 0 },
			{ path: "a.ts", start_line: 1.5 },
			{ path: "a.ts", extra: true },
		],
	},
	{
		tool: "write",
		valid: [{ path: "a.ts", content: "text" }],
		invalid: [
			"x",
			{ path: "a.ts" },
			{ path: "a.ts", content: 1 },
			{ path: "a.ts", content: "text", extra: true },
		],
	},
	{
		tool: "edit",
		valid: [
			{ path: "a.ts", edits: [{ old: "x", new: "y" }] },
			{ path: "a.ts", edits: [{ old: "x", new: "y", replace_all: true }] },
		],
		invalid: [
			{ path: "a.ts", edits: [] },
			{ path: "a.ts", edits: [{ old: "", new: "y" }] },
			{ path: "a.ts", edits: [{ old: "x", new: "y", replace_all: "true" }] },
			{ path: "a.ts", edits: [{ old: "x", new: "y", extra: true }] },
			{ path: "a.ts", edits: [{ old: "x", new: "y" }], extra: true },
		],
	},
] as const;

describe("file tool schemas", () => {
	it.each(schemaCases)("$tool 限制字段、类型和范围", ({ tool, valid, invalid }) => {
		for (const value of valid) expect(validate(tool, value)).toBe(true);
		for (const value of invalid) expect(validate(tool, value)).toBe(false);
	});

	it.each([
		["find", { query: "x", path: "src tests" }, { query: "x", path: ["src", "tests"] }],
		["grep", { query: "x", path: "src,tests" }, { query: "x", path: ["src", "tests"] }],
	] as const)("%s 规范化多路径参数", (toolName, input, expected) => {
		expect(tools.get(toolName)?.prepareArguments?.(input)).toEqual(expected);
	});

	it.each([
		["write", { path: "a.ts", content: 1 }],
		["edit", { path: "a.ts", edits: [{ old: "", new: "y" }] }],
	] as const)("%s repair 后仍非法的参数由 schema 拒绝", (toolName, input) => {
		const prepared = tools.get(toolName)?.prepareArguments?.(input) ?? input;
		expect(validate(toolName, prepared)).toBe(false);
	});
});
