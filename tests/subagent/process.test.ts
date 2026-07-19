import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentCommand } from "../../src/subagent/commands.js";
import { executeSubagent, resolveMode } from "../../src/subagent/executor.js";
import { resetSubagentSpawnForTests, runPiProcess, setSubagentSpawnForTests } from "../../src/subagent/process.js";
import { SUBAGENT_COMMAND_ENTRY } from "../../src/subagent/renderer.js";
import type { AgentDefinition, ProcessRunInput, ProcessRunProgress } from "../../src/subagent/types.js";
import { countTextTokensSync } from "../../src/token-counter.js";
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
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("subagent execution", () => {
	it("仅在 task 包含 {previous} 时推导 chain", () => {
		expect(resolveMode([{ agent: "scout", task: "inspect" }])).toBe("parallel");
		expect(resolveMode([{ agent: "scout", task: "inspect {previous}" }])).toBe("chain");
		expect(resolveMode([{ agent: "scout", task: "inspect {previous_result}" }])).toBe("parallel");
	});

	it("并行执行汇总结果并持续发送进度", async () => {
		setOutputSpawn((task) => `done: ${task}`);
		const updates: number[] = [];

		const result = await executeSubagent(
			{ tasks: [{ agent: "scout", task: "inspect auth" }, { agent: "scout", task: "inspect tests" }] },
			context({ onUpdate: (partial) => updates.push(partial.details.results.length) }),
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Subagents: 2/2 succeeded") });
		expect(result.details.mode).toBe("parallel");
		expect(result.details.results.map((item) => item.cwd)).toEqual([workspace, workspace]);
		expect(result.details.results.map((item) => item.output)).toEqual(["done: inspect auth", "done: inspect tests"]);
		expect(updates).toContain(2);
	});

	it("/run 在主 TUI 实时更新 widget，完成后落为非模型上下文 entry", async () => {
		setOutputSpawn(() => "manual run done");
		const widgets: unknown[] = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const notify = vi.fn();

		await runSubagentCommand(
			{
				getAllTools: () => [{ name: "read" }],
				appendEntry(type, data) {
					if (data !== undefined) entries.push({ type, data });
				},
			},
			{
				cwd: workspace,
				hasUI: true,
				model: undefined,
				signal: undefined,
				ui: {
					confirm: async () => true,
					getToolsExpanded: () => true,
					notify,
					setWidget(_key, content) {
						widgets.push(content);
					},
				},
			},
			[{ agent: "scout", task: "manual inspect" }],
		);

		expect(widgets.length).toBeGreaterThanOrEqual(3);
		expect(widgets[0]).toEqual(expect.any(Function));
		expect(widgets.at(-1)).toBeUndefined();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: SUBAGENT_COMMAND_ENTRY,
			data: { details: { results: [{ output: "manual run done" }] } },
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("task 级 cwd 覆盖 workspace 默认值", async () => {
		await mkdir(path.join(workspace, "pkg"));
		setOutputSpawn(() => "done");

		const result = await executeSubagent({ tasks: [{ agent: "scout", task: "inspect", cwd: "pkg" }] }, context());

		expect(result.details.results[0]?.cwd).toBe(path.join(workspace, "pkg"));
	});

	it("通过 --system-prompt 直接传递原始 Agent Markdown 路径", async () => {
		let capturedArgs: readonly string[] = [];
		setSubagentSpawnForTests((_command, args, options) => {
			capturedArgs = args;
			expect(options.env?.PI_SUBAGENT_CHILD).toBe("1");
			const proc = new FakeChildProcess();
			queueMicrotask(() => {
				proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "text", text: "done" }]))}\n`);
				proc.exitCode = 0;
				proc.emit("close", 0);
			});
			return proc;
		});

		await runPiProcess(input());

		const systemPromptIndex = capturedArgs.indexOf("--system-prompt");
		expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
		expect(capturedArgs[systemPromptIndex + 1]).toBe(agent().filePath);
		expect(capturedArgs).not.toContain("--append-system-prompt");
	});

	it("输出超过 inline token 边界时只返回一行文件提示", async () => {
		const output = "alpha beta gamma delta ".repeat(200);
		const tokenLimit = countTextTokensSync(output, { modelId: "test-model" }).tokens - 1;
		expect(tokenLimit).toBeGreaterThanOrEqual(250);
		const configPath = process.env.PI_SUBAGENT_USER_CONFIG;
		if (configPath === undefined) throw new Error("subagent config path missing");
		await writeFile(configPath, JSON.stringify({ retry_delay_ms: 0, max_inline_output_tokens: tokenLimit }));
		setOutputSpawn(() => output);

		const result = await executeSubagent({ tasks: [{ agent: "scout", task: "large" }] }, context());
		const persisted = result.details.results[0];
		if (persisted?.outputFile === undefined) throw new Error("subagent output file missing");

		expect(resultText(result)).toBe(`Subagent scout produced too much output for inline return; full output saved to ${persisted.outputFile}.`);
		expect(resultText(result)).not.toContain("\n");
		expect(resultText(result)).not.toContain(output);
		expect(await readFile(persisted.outputFile, "utf8")).toBe(output);
	});

	it("chain 将上一步输出传入 {previous}，失败时停止后续步骤", async () => {
		setOutputSpawn((task) => task === "seed" ? "handoff" : task.includes("stop") ? undefined : `received ${task}`);
		const success = await executeSubagent(
			{ tasks: [{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }] },
			context(),
		);
		expect(success.details.mode).toBe("chain");
		expect(success.details.results.map((item) => item.task)).toEqual(["seed", "use handoff"]);
		expect(success.content[0]).toMatchObject({ text: "received use handoff" });

		const failed = await executeSubagent(
			{ tasks: [{ agent: "scout", task: "stop" }, { agent: "scout", task: "never {previous}" }] },
			context(),
		);
		expect(failed.details.results).toHaveLength(1);
		expect(failed.content[0]).toMatchObject({ text: expect.stringContaining("Chain stopped at step 1") });
	});

	it("chain 自动把超限的上一步输出替换为文件引用", async () => {
		const configPath = process.env.PI_SUBAGENT_USER_CONFIG;
		if (configPath === undefined) throw new Error("subagent config path missing");
		const largeOutput = "alpha beta gamma delta ".repeat(200);
		const tokenLimit = countTextTokensSync(largeOutput, { modelId: "test-model" }).tokens - 1;
		expect(tokenLimit).toBeGreaterThanOrEqual(250);
		await writeFile(configPath, JSON.stringify({ retry_delay_ms: 0, max_inline_output_tokens: tokenLimit }));
		setOutputSpawn((task) => task === "seed" ? largeOutput : `received ${task}`);

		const result = await executeSubagent(
			{ tasks: [{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }] },
			context(),
		);
		const handoffTask = result.details.results[1]?.task ?? "";

		expect(handoffTask).toContain("output exceeded the handoff limit");
		expect(handoffTask).toContain(path.join(".pi", "subagents", "runs"));
		expect(handoffTask).not.toContain(largeOutput);
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

	it("正常退出时移除复用 AbortSignal 上的监听器", async () => {
		setOutputSpawn(() => "done");
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");

		await runPiProcess(input(), { signal: controller.signal });

		expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("终止导致子进程同步 close 时不遗留强杀 timer", async () => {
		vi.useFakeTimers();
		setOutputSpawn(() => "unused");
		const controller = new AbortController();
		controller.abort();

		const result = await runPiProcess(input(), { signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
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
		source: "user",
		filePath: "/agents/scout.md",
		hasWriteCapability: false,
	};
}
