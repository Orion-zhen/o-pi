import { createEventBus, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import fileTools from "../../../src/harness/extensions/file-tools.ts";
import subagentExtension from "../../../src/harness/extensions/subagent.ts";
import { DEFAULT_MAX_PATH_COUNT, repairableTool, type RepairObservation } from "../../../src/harness/tool-repair/index.ts";
import type { RepairableToolDefinition } from "../../../src/harness/tool-repair/repair.ts";
import { registerExtension } from "../../helpers/extension.ts";

const simpleSchema = Type.Object(
	{
		path: Type.String(),
		start_line: Type.Optional(Type.Integer({ minimum: 1 })),
		end_line: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
const pathListSchema = Type.Object(
	{
		query: Type.String(),
		path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	},
	{ additionalProperties: false },
);

describe("tool-input repair", () => {
	it("修复别名、数字字符串、optional null、路径前缀和 unknown fields", () => {
		const tool = repairableTool(
			defineNoopTool(simpleSchema),
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

	it("合法参数原样传递，修复不修改原输入", () => {
		let observation: RepairObservation | undefined;
		const tool = repairableTool(defineNoopTool(simpleSchema), { aliases: { file: "path" } }, {
			onPreparation(value) { observation = value; },
		});
		const valid = { path: "src/a.ts" };
		expect(tool.prepareArguments?.(valid)).toBe(valid);
		expect(observation).toMatchObject({ status: "accepted", operations: [] });
		const invalid = { file: "src/a.ts" };
		expect(tool.prepareArguments?.(invalid)).toEqual(valid);
		expect(invalid).toEqual({ file: "src/a.ts" });
		expect(observation).toMatchObject({ status: "repaired", operations: ["root_alias"] });
	});

	it.each([
		{
			name: "单路径字符串",
			input: { query: "auth", path: "@src" },
			expected: { query: "auth", path: ["src"] },
			operations: ["scalar_to_array", "strip_path_prefix"],
		},
		{
			name: "逗号、空白和引号保护",
			input: { query: "auth", path: "@src,\n\"@tests, with space\" @src" },
			expected: { query: "auth", path: ["src", "tests, with space"] },
			operations: ["split_path_list", "strip_path_prefix"],
		},
	] as const)("迁移路径字符串: $name", ({ input, expected, operations }) => {
		let observation: RepairObservation | undefined;
		const tool = repairableTool(defineNoopTool(pathListSchema), {
			pathFields: ["path"],
			pathListFields: ["path"],
		}, { onPreparation: (value) => { observation = value; } });

		expect(tool.prepareArguments?.(input)).toEqual(expected);
		expect(observation).toMatchObject({
			status: "repaired",
			operations,
			fanout: { field: "path", count: expected.path.length, separator: expected.path.length === 1 ? "scalar" : "mixed" },
		});
	});

	it("只在 pathListFields 中拆分路径，拒绝空 token、超限和不可解析输入", () => {
		const tool = repairableTool(defineNoopTool(pathListSchema), {
			pathFields: ["path"],
			pathListFields: ["path"],
		});

		expect(tool.prepareArguments?.({ query: "foo bar", path: "src a" })).toEqual({ query: "foo bar", path: ["src", "a"] });
		expect(tool.prepareArguments?.({ query: "foo bar", path: "src,,a" })).toEqual({ query: "foo bar", path: "src,,a" });
		const paths = Array.from({ length: DEFAULT_MAX_PATH_COUNT }, (_, index) => `src/${index}`);
		expect(tool.prepareArguments?.({ query: "foo bar", path: paths.join(" ") })).toEqual({ query: "foo bar", path: paths });
		const overflow = [...paths, "extra"].join(" ");
		expect(tool.prepareArguments?.({ query: "foo bar", path: overflow })).toEqual({ query: "foo bar", path: overflow });
		expect(tool.prepareArguments?.({ query: "foo bar", path: "\"src/a" })).toEqual({ query: "foo bar", path: "\"src/a" });

		const ordinary = repairableTool(defineNoopTool(Type.Object({ query: Type.String() }, { additionalProperties: false })), {
			pathListFields: ["query"],
		});
		expect(ordinary.prepareArguments?.({ query: "foo bar" })).toEqual({ query: "foo bar" });
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
		const registered = new Map(registerExtension<ToolDefinition>(fileTools).registered.map((tool) => [tool.name, tool]));
		expect(registered.get("read")?.prepareArguments?.("@src/a.ts"))
			.toEqual({ path: "src/a.ts" });
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
			events: createEventBus(),
		} as unknown as ExtensionAPI);

		expect(registered?.prepareArguments?.({
			tasks: { agent: "scout", task: "inspect", cwd: "@pkg" },
		})).toEqual({
			tasks: [{ agent: "scout", task: "inspect", cwd: "pkg" }],
		});
	});

	it("schema 默认值不改变空字符串或 optional null 的语义", () => {
		const tool = repairableTool(defineNoopTool(Type.Object({
			query: Type.String(),
			mode: Type.Optional(Type.String({ default: "auto" })),
		}, { additionalProperties: false })));
		expect(tool.prepareArguments?.({ query: "test", mode: null })).toEqual({ query: "test" });
		expect(tool.prepareArguments?.({ query: "test", mode: "" })).toEqual({ query: "test", mode: "" });
	});
});

function defineNoopTool<TParams extends TSchema>(
	parameters: TParams,
): RepairableToolDefinition<TParams> {
	return {
		name: "noop",
		label: "noop",
		description: "noop",
		parameters,
		async execute() {
			return { content: [{ type: "text", text: "" }], details: undefined };
		},
	};
}
