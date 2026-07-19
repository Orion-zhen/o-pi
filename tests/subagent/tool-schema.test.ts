import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import subagentExtension from "../../agent/extensions/subagent.js";
import { SUBAGENT_COMMAND_ENTRY } from "../../src/subagent/renderer.js";

interface RegisteredSubagentTool {
	parameters: AnySchema;
}

function subagentTool(): RegisteredSubagentTool {
	let registered: unknown;
	subagentExtension({
		registerTool(tool: unknown) {
			registered = tool;
		},
		registerCommand() {},
		registerEntryRenderer() {},
		on() {},
	} as never);
	return registered as RegisteredSubagentTool;
}

function subagentSchema(): AnySchema {
	return subagentTool().parameters;
}

function validateParams(value: unknown): boolean {
	const ajv = new Ajv({ strict: false });
	return ajv.compile(subagentSchema())(value) === true;
}

describe("subagent tool schema", () => {
	it("只注册 agents、run 和 subagent-config 命令", () => {
		const commands: string[] = [];
		const entryRenderers: string[] = [];
		subagentExtension({
			registerTool() {},
			registerCommand(name: string) {
				commands.push(name);
			},
			registerEntryRenderer(type: string) {
				entryRenderers.push(type);
			},
			on() {},
		} as never);

		expect(commands).toEqual(["agents", "run", "subagent-config"]);
		expect(entryRenderers).toEqual([SUBAGENT_COMMAND_ENTRY]);
	});

	it("接受一个或多个 agent task，并允许每项指定 cwd", () => {
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }] })).toBe(true);
		expect(validateParams({ tasks: [{ agent: "scout", task: "use {previous}", cwd: "." }] })).toBe(true);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }, { agent: "reviewer", task: "review" }] })).toBe(true);
	});

	it("拒绝旧模式字段、未知字段和空任务数组", () => {
		expect(validateParams({ mode: "single", agent: "scout", task: "inspect" })).toBe(false);
		expect(validateParams({ mode: "parallel", tasks: [{ agent: "scout", task: "inspect" }] })).toBe(false);
		expect(validateParams({ mode: "chain", tasks: [{ agent: "scout", task: "use {previous}" }] })).toBe(false);
		expect(validateParams({ agent: "scout", task: "inspect" })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], model: "other-model" })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], cwd: "." })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], outputMode: "file" })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], output_mode: "file" })).toBe(false);
		expect(validateParams({ tasks: [] })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect", extra: true }] })).toBe(false);
	});

	it("不暴露运行时安全、并发或重试配置", () => {
		const schemaText = JSON.stringify(subagentSchema());
		expect(schemaText).not.toContain("agentScope");
		expect(schemaText).not.toContain("allowProjectAgents");
		expect(schemaText).not.toContain("maxConcurrency");
		expect(schemaText).not.toContain("retries");
		expect(schemaText).not.toContain("outputMode");
		expect(schemaText).not.toContain('"mode"');
	});
});
