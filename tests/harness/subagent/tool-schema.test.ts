import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "../../../src/harness/extensions/subagent.ts";
import { presentation } from "../../../src/tui/extensions.ts";
const subagentExtension = createSubagentExtension(presentation.subagent);
import { preserveEnv } from "../../helpers/lifecycle.ts";

preserveEnv("PI_SUBAGENT_CHILD", "PI_SUBAGENT_FORK");

interface RegisteredSubagentTool {
	execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function subagentTool(): RegisteredSubagentTool {
	let registered: unknown;
	subagentExtension({
		events: createEventBus(),
		registerTool(tool: unknown) {
			registered = tool;
		},
		registerCommand() {},
		registerEntryRenderer() {},
		on() {},
	} as never);
	return registered as RegisteredSubagentTool;
}

describe("subagent recursion", () => {
	it("子进程保留 schema 但运行时阻止递归", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";

		await expect(subagentTool().execute("call", { tasks: [{ agent: "scout", task: "nested" }] }, undefined, undefined, {}))
			.rejects.toThrow();
	});
});
