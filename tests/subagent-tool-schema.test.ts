import { describe, expect, it } from "vitest";
import subagentExtension from "../agent/extensions/subagent.js";

describe("subagent tool schema", () => {
	it("不暴露安全、并发或重试策略，也不使用复杂条件结构", () => {
		let registered: unknown;
		subagentExtension({
			registerTool(tool: unknown) {
				registered = tool;
			},
			registerCommand() {},
			on() {},
		} as never);
		const schemaText = JSON.stringify((registered as { parameters: unknown }).parameters);
		expect(schemaText).not.toContain("agentScope");
		expect(schemaText).not.toContain("allowProjectAgents");
		expect(schemaText).not.toContain("maxConcurrency");
		expect(schemaText).not.toContain("retries");
		expect(schemaText).not.toContain("anyOf");
		expect(schemaText).not.toContain("oneOf");
		expect(schemaText).not.toContain("allOf");
		expect(schemaText).not.toContain("if");
	});
});
