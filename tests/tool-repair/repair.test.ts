import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import subagentExtension from "../../agent/extensions/subagent.js";
import { repairableTool } from "../../src/tool-repair/index.js";

const simpleSchema = Type.Object(
	{
		path: Type.String(),
		start_line: Type.Optional(Type.Integer({ minimum: 1 })),
		end_line: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

describe("tool-input repair", () => {
	it("在原 prepareArguments 后修复别名、数字字符串、optional null、路径前缀和 unknown fields", () => {
		const tool = repairableTool(
			defineNoopTool(simpleSchema, {
				prepareArguments(args) {
					return args as { path: string; start_line?: number; end_line?: number };
				},
			}),
			{
				pathFields: ["path"],
				aliases: {
					startLine: "start_line",
					endLine: "end_line",
				},
			},
		);

		expect(tool.prepareArguments?.({
			path: "@src/a.ts",
			startLine: "2",
			end_line: null,
			extra: true,
		})).toEqual({
			path: "src/a.ts",
			start_line: 2,
		});
	});

	it("支持单字符串对象工具调用，但不会返回半修复非法参数", () => {
		const tool = repairableTool(defineNoopTool(simpleSchema), {
			singleStringField: "path",
			pathFields: ["path"],
		});
		expect(tool.prepareArguments?.("@src/a.ts")).toEqual({ path: "src/a.ts" });

		const invalid = { path: 42, start_line: "3" };
		expect(tool.prepareArguments?.(invalid)).toBe(invalid);
	});

	it("修复 edit 常见结构错误，但不改写 old/new 内容", () => {
		const editSchema = Type.Object(
			{
				path: Type.String(),
				edits: Type.Array(
					Type.Object({ old: Type.String({ minLength: 1 }), new: Type.String() }, { additionalProperties: false }),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		);
		const tool = repairableTool(defineNoopTool(editSchema), {
			pathFields: ["path"],
			aliases: {
				oldText: "old",
				newText: "new",
			},
			nestedAliases: {
				"edits.*.oldText": "old",
				"edits.*.newText": "new",
			},
			objectArrayFromFields: [{ arrayField: "edits", fields: ["old", "new"] }],
		});

		expect(tool.prepareArguments?.({ path: "@a.ts", oldText: " x ", newText: " y " })).toEqual({
			path: "a.ts",
			edits: [{ old: " x ", new: " y " }],
		});
		expect(tool.prepareArguments?.({
			path: "a.ts",
			edits: { oldText: "x", newText: "y" },
		})).toEqual({
			path: "a.ts",
			edits: [{ old: "x", new: "y" }],
		});
		expect(tool.prepareArguments?.({
			path: "a.ts",
			edits: "[{\"oldText\":\"x\",\"newText\":\"y\"}]",
		})).toEqual({
			path: "a.ts",
			edits: [{ old: "x", new: "y" }],
		});
	});

	it("实际 file-tools 注册的 read/write/edit 均挂载 prepareArguments", () => {
		const registered = registerFileTools();
		expect(registered.get("read")?.prepareArguments?.({
			path: "@src/a.ts",
			startLine: "1",
		})).toEqual({ path: "src/a.ts", start_line: 1 });
		expect(registered.get("write")?.prepareArguments?.({
			path: "@src/a.ts",
			text: " keep whitespace ",
		})).toEqual({ path: "src/a.ts", content: " keep whitespace " });
		expect(registered.get("edit")?.prepareArguments?.({
			path: "@src/a.ts",
			oldText: " old ",
			newText: " new ",
		})).toEqual({ path: "src/a.ts", edits: [{ old: " old ", new: " new " }] });
	});

	it("实际 subagent 注册支持 tasks 单对象和嵌套 cwd 路径", () => {
		let registered: ToolDefinition | undefined;
		subagentExtension({
			registerTool(tool: ToolDefinition) {
				registered = tool;
			},
			registerCommand() {},
			registerEntryRenderer() {},
			on() {},
		} as unknown as ExtensionAPI);

		expect(registered?.prepareArguments?.({
			tasks: { agent: "scout", task: "inspect", cwd: "@pkg" },
		})).toEqual({
			tasks: [{ agent: "scout", task: "inspect", cwd: "pkg" }],
		});
	});
});

function defineNoopTool<TParams extends TSchema>(
	parameters: TParams,
	extras: Partial<ToolDefinition<TParams>> = {},
): ToolDefinition<TParams> {
	return {
		name: "noop",
		label: "noop",
		description: "noop",
		parameters,
		async execute() {
			return { content: [{ type: "text", text: "" }], details: undefined };
		},
		...extras,
	};
}

function registerFileTools(): Map<string, ToolDefinition> {
	const registered = new Map<string, ToolDefinition>();
	fileTools({
		registerTool(tool: ToolDefinition) {
			registered.set(tool.name, tool);
		},
		on() {},
	} as unknown as ExtensionAPI);
	return registered;
}
