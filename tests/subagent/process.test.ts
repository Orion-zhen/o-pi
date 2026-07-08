import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { resetSubagentSpawnForTests, runPiProcess, setSubagentSpawnForTests } from "../../src/subagent/process.js";
import type { AgentDefinition, ProcessRunInput, ProcessRunProgress } from "../../src/subagent/types.js";

afterEach(() => {
	resetSubagentSpawnForTests();
});

describe("subagent process", () => {
	it("解析 JSONL 时发送实时进度快照", async () => {
		setSubagentSpawnForTests(() => {
			const proc = new FakeChildProcess();
			queueMicrotask(() => {
				proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "toolCall", name: "read", arguments: { path: "src/subagent/renderer.ts" } }]))}\n`);
				proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "text", text: "done" }]))}\n`);
				proc.exitCode = 0;
				proc.emit("close", 0);
			});
			return proc;
		});
		const updates: ProcessRunProgress[] = [];

		const output = await runPiProcess(input(), { onUpdate: (progress) => updates.push(progress) });

		expect(output.output).toBe("done");
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]?.events).toEqual([{ type: "tool", name: "read", args: { path: "src/subagent/renderer.ts" } }]);
		expect(updates.at(-1)?.events.at(-1)).toEqual({ type: "text", text: "done" });
	});
});

class FakeChildProcess extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;

	kill(): boolean {
		this.exitCode = 1;
		this.emit("close", 1);
		return true;
	}
}

function messageEnd(content: Array<Record<string, unknown>>): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "end",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			content,
		},
	};
}

function input(): ProcessRunInput {
	return {
		runId: "run-1",
		mode: "parallel",
		agent: agent(),
		task: "inspect renderer",
		cwd: process.cwd(),
		tools: ["read"],
		timeoutMs: 1000,
		attempt: 1,
		maxAttempts: 1,
	};
}

function agent(): AgentDefinition {
	return {
		name: "scout",
		description: "Scout",
		tools: ["read"],
		systemPrompt: "",
		source: "user",
		filePath: "/agents/scout.md",
		hasWriteCapability: false,
	};
}
