import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import subagentExtension from "../../agent/extensions/subagent.js";
import { SUBAGENT_COMMAND_ENTRY } from "../../src/subagent/constants.js";
import { preserveEnv } from "../helpers/lifecycle.js";

preserveEnv("PI_SUBAGENT_CHILD", "PI_SUBAGENT_FORK");

interface RegisteredSubagentTool {
	parameters: AnySchema;
	execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
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
	it("只注册 agents、run 和 subagent-config 命令", async () => {
		const commands: string[] = [];
		const entryRenderers: string[] = [];
		let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
		subagentExtension({
			registerTool() {},
			registerCommand(name: string) {
				commands.push(name);
			},
			registerEntryRenderer(type: string) {
				entryRenderers.push(type);
			},
			on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
				if (name === "session_start") sessionStart = handler;
			},
		} as never);
		await sessionStart?.({}, { mode: "rpc", ui: { notify() {} } });
		expect(entryRenderers).toEqual([]);
		await sessionStart?.({}, { mode: "tui", ui: { notify() {} } });

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

	it("子进程保留 schema 但运行时阻止递归", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";

		const result = await subagentTool().execute("call", { tasks: [{ agent: "scout", task: "nested" }] }, undefined, undefined, {});

		expect(result.content[0]?.text).toContain("Recursive subagent calls are forbidden");
	});

	it("不暴露运行时安全、并发或重试配置", () => {
		const schemaText = JSON.stringify(subagentSchema());
		expect(schemaText).not.toContain("agentScope");
		expect(schemaText).not.toContain("allowProjectAgents");
		expect(schemaText).not.toContain("maxConcurrency");
		expect(schemaText).not.toContain("retries");
		expect(schemaText).not.toContain("fork");
		expect(schemaText).not.toContain("outputMode");
		expect(schemaText).not.toContain('"mode"');
	});
});
