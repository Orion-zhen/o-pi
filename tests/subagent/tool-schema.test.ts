import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import subagentExtension from "../../agent/extensions/subagent.js";

function subagentSchema(): AnySchema {
	let registered: unknown;
	subagentExtension({
		registerTool(tool: unknown) {
			registered = tool;
		},
		registerCommand() {},
		on() {},
	} as never);
	return (registered as { parameters: AnySchema }).parameters;
}

function validateParams(value: unknown): boolean {
	const ajv = new Ajv({ strict: false });
	return ajv.compile(subagentSchema())(value) === true;
}

describe("subagent tool schema", () => {
	it("使用 tasks 数组，只有 chain 需要显式 mode", () => {
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }] })).toBe(true);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], outputMode: "file" })).toBe(true);
		expect(validateParams({ mode: "chain", tasks: [{ agent: "scout", task: "inspect" }], outputMode: "inline" })).toBe(true);
	});

	it("拒绝旧模式字段、未知字段和空任务数组", () => {
		expect(validateParams({ mode: "single", agent: "scout", task: "inspect" })).toBe(false);
		expect(validateParams({ mode: "parallel", tasks: [{ agent: "scout", task: "inspect" }] })).toBe(false);
		expect(validateParams({ agent: "scout", task: "inspect" })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect" }], model: "other-model" })).toBe(false);
		expect(validateParams({ mode: "chain", tasks: [] })).toBe(false);
		expect(validateParams({ tasks: [{ agent: "scout", task: "inspect", extra: true }] })).toBe(false);
	});

	it("不暴露运行时安全、并发或重试配置", () => {
		const schemaText = JSON.stringify(subagentSchema());
		expect(schemaText).not.toContain("agentScope");
		expect(schemaText).not.toContain("allowProjectAgents");
		expect(schemaText).not.toContain("maxConcurrency");
		expect(schemaText).not.toContain("retries");
	});
});
