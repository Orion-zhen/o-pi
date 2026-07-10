import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSubagent } from "../../src/subagent/executor.js";
import { resetSubagentSpawnForTests, runPiProcess, setSubagentSpawnForTests } from "../../src/subagent/process.js";
import type { AgentDefinition, ProcessRunInput, ProcessRunProgress } from "../../src/subagent/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-subagent-execution-");
preserveEnv("HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_USER_CONFIG", "PI_SUBAGENT_PROJECT_CONFIG");

beforeEach(async () => {
	workspace = temp.path;
	process.env.HOME = workspace;
	process.env.PI_CODING_AGENT_DIR = path.join(workspace, "agent");
	process.env.PI_SUBAGENT_USER_CONFIG = path.join(workspace, "subagent.jsonc");
	process.env.PI_SUBAGENT_PROJECT_CONFIG = path.join(workspace, "missing-project.jsonc");
	await mkdir(path.join(workspace, "agent", "agents"), { recursive: true });
	await writeAgent("scout", "read");
	await writeFile(process.env.PI_SUBAGENT_USER_CONFIG, '{ "retry_delay_ms": 0 }');
});

afterEach(() => {
	resetSubagentSpawnForTests();
});

describe("subagent execution", () => {
	it("并行执行汇总结果并持续发送进度", async () => {
		setOutputSpawn((task) => `done: ${task}`);
		const updates: number[] = [];

		const result = await executeSubagent(
			{ tasks: [{ agent: "scout", task: "inspect auth" }, { agent: "scout", task: "inspect tests" }] },
			context({ onUpdate: (partial) => updates.push(partial.details.results.length) }),
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Subagents: 2/2 succeeded") });
		expect(result.details.results.map((item) => item.output)).toEqual(["done: inspect auth", "done: inspect tests"]);
		expect(updates).toContain(2);
	});

	it("chain 将上一步输出传入 {previous}，失败时停止后续步骤", async () => {
		setOutputSpawn((task) => task === "seed" ? "handoff" : task.includes("stop") ? undefined : `received ${task}`);
		const success = await executeSubagent(
			{ mode: "chain", tasks: [{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }] },
			context(),
		);
		expect(success.details.results.map((item) => item.task)).toEqual(["seed", "use handoff"]);
		expect(success.content[0]).toMatchObject({ text: "received use handoff" });

		const failed = await executeSubagent(
			{ mode: "chain", tasks: [{ agent: "scout", task: "stop" }, { agent: "scout", task: "never" }] },
			context(),
		);
		expect(failed.details.results).toHaveLength(1);
		expect(failed.content[0]).toMatchObject({ text: expect.stringContaining("Chain stopped at step 1") });
	});

	it("只读失败会重试，成功后保留实际 attempts", async () => {
		let calls = 0;
		setOutputSpawn(() => ++calls === 1 ? undefined : "recovered");

		const result = await executeSubagent({ tasks: [{ agent: "scout", task: "retry" }] }, context());

		expect(calls).toBe(2);
		expect(result.details.results[0]).toMatchObject({ attempts: 2, output: "recovered" });
	});

	it("统一拒绝空任务、未知 agent、越界 cwd 和未确认的写能力", async () => {
		await writeAgent("worker", "read, edit");
		const cases = [
			await executeSubagent({ tasks: [] }, context()),
			await executeSubagent({ tasks: [{ agent: "missing", task: "x" }] }, context()),
			await executeSubagent({ tasks: [{ agent: "scout", task: "x", cwd: ".." }] }, context()),
			await executeSubagent({ tasks: [{ agent: "worker", task: "write" }] }, context({ registeredTools: ["read", "edit"] })),
			await executeSubagent(
				{ tasks: [{ agent: "worker", task: "write" }] },
				context({ hasUI: true, registeredTools: ["read", "edit"], confirm: async () => false }),
			),
		];

		expect(cases.map(resultText)).toEqual([
			expect.stringContaining("tasks must not be empty"),
			expect.stringContaining('Unknown agent "missing"'),
			expect.stringContaining("cwd escapes workspace"),
			expect.stringContaining("confirmation UI is unavailable"),
			expect.stringContaining("Canceled write-capable agent"),
		]);
	});

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

function context(overrides: Partial<Parameters<typeof executeSubagent>[1]> = {}): Parameters<typeof executeSubagent>[1] {
	return {
		cwd: workspace,
		hasUI: false,
		currentModel: "test-model",
		registeredTools: ["read"],
		...overrides,
	};
}

async function writeAgent(name: string, tools: string): Promise<void> {
	await writeFile(
		path.join(workspace, "agent", "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${name}\ntools: ${tools}\n---\nFollow the task.`,
	);
}

function setOutputSpawn(outputForTask: (task: string) => string | undefined): void {
	setSubagentSpawnForTests((_command, args) => {
		const task = args.at(-1)?.replace(/^Task: /, "") ?? "";
		const output = outputForTask(task);
		const proc = new FakeChildProcess();
		queueMicrotask(() => {
			if (output !== undefined) proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "text", text: output }]))}\n`);
			proc.exitCode = 0;
			proc.emit("close", 0);
		});
		return proc;
	});
}

function resultText(result: Awaited<ReturnType<typeof executeSubagent>>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

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
