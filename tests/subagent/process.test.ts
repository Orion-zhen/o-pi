import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentCommand } from "../../src/subagent/commands.js";
import { executeSubagent, resolveMode } from "../../src/subagent/executor.js";
import { PiJsonProgressAccumulator } from "../../src/subagent/json-progress.js";
import { resetSubagentSpawnForTests, runPiProcess, setSubagentSpawnForTests } from "../../src/subagent/process.js";
import {
	cleanupForkExecutionContext,
	createForkExecutionContext,
} from "../../src/subagent/session-context.js";
import type {
	AgentDefinition,
	ExecutorContext,
	NonEmptyArray,
	ProcessRunInput,
	ProcessRunProgress,
	SubagentProgressEvent,
	SubagentTask,
} from "../../src/subagent/types.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
const temp = useTempDir("o-pi-subagent-execution-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_USER_CONFIG", "PI_SUBAGENT_PROJECT_CONFIG");

beforeEach(async () => {
	workspace = temp.path;
	setTestHome(workspace);
	process.env.PI_CODING_AGENT_DIR = path.join(workspace, "agent");
	process.env.PI_SUBAGENT_USER_CONFIG = path.join(workspace, "subagent.jsonc");
	process.env.PI_SUBAGENT_PROJECT_CONFIG = path.join(workspace, "missing-project.jsonc");
	await mkdir(path.join(workspace, "agent", "agents"), { recursive: true });
	await writeAgent("scout", "read");
});

afterEach(() => {
	resetSubagentSpawnForTests();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("subagent execution", () => {
	it("并行执行汇总结果、task cwd 和实时进度", async () => {
		await mkdir(path.join(workspace, "pkg"));
		setOutputSpawn((task) => `done: ${task}`);
		const updates: number[] = [];

		const result = await runTasks(
			[{ agent: "scout", task: "inspect auth" }, { agent: "scout", task: "inspect tests", cwd: "pkg" }],
			context({ onUpdate: (partial) => updates.push(partial.details.results.length) }),
		);

		expect(result.details.mode).toBe("parallel");
		expect(result.details.results.map((item) => item.cwd)).toEqual([workspace, path.join(workspace, "pkg")]);
		expect(result.details.results.map((item) => item.output)).toEqual(["done: inspect auth", "done: inspect tests"]);
		expect(updates).toContain(2);
	});

	it("/run application 以统一结构发送进度并返回最终结果", async () => {
		setOutputSpawn(() => "manual run done");
		const updates: SubagentProgressEvent[] = [];

		const result = await runSubagentCommand(
			{
				getActiveTools: () => ["read"],
				getAllTools: () => [toolInfo("read")],
				getThinkingLevel: () => "off",
			},
			{
				cwd: workspace,
				model: undefined,
				sessionManager: emptySessionManager(),
				systemPrompt: "parent prompt",
				interaction: { confirmWrite: async () => true },
			},
			[{ agent: "scout", task: "manual inspect" }],
			(update) => updates.push(update),
		);

		expect(updates[0]).toMatchObject({ phase: "starting", result: { details: { runId: "pending" } } });
		expect(updates).toContainEqual(expect.objectContaining({ phase: "running" }));
		expect(updates.at(-1)).toMatchObject({
			phase: "completed",
			result: { details: { results: [{ output: "manual run done" }] } },
		});
		expect(result.details.results[0]?.output).toBe("manual run done");
	});

	it("通过 --system-prompt 直接传递原始 Agent Markdown 路径", async () => {
		let capturedArgs: readonly string[] = [];
		setSubagentSpawnForTests((_command, args, options) => {
			capturedArgs = args;
			expect(options.env?.PI_SUBAGENT_CHILD).toBe("1");
			return completedProcess(messageStart(), messageEnd([{ type: "text", text: "done" }]));
		});

		await runPiProcess(input());

		const systemPromptIndex = capturedArgs.indexOf("--system-prompt");
		expect(capturedArgs[systemPromptIndex + 1]).toBe(agent().filePath);
		expect(capturedArgs).not.toContain("--append-system-prompt");
	});

	it("fork 固定复用父上下文并忽略 Agent、配置和 task 覆盖", async () => {
		await mkdir(path.join(workspace, "pkg"));
		await writeAgent("forker", "edit", {
			fork: true,
			model: "ignored/model",
			body: "Inspect only the requested scope.",
		});
		await writeConfig({
			default_model: "ignored/default",
			agent_overrides: { forker: { model: "ignored/override", tools: ["write"] } },
		});
		let capturedArgs: readonly string[] = [];
		let capturedEnv: NodeJS.ProcessEnv | undefined;
		let snapshot = "";
		let snapshotPath = "";
		setSubagentSpawnForTests((_command, args, options) => {
			capturedArgs = args;
			capturedEnv = options.env;
			const proc = new FakeChildProcess();
			queueMicrotask(async () => {
				snapshotPath = args[args.indexOf("--fork") + 1] as string;
				snapshot = await readFile(snapshotPath, "utf8");
				proc.stdout.write(`${JSON.stringify(messageStart())}\n`);
				proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "text", text: "fork done" }]))}\n`);
				proc.exitCode = 0;
				proc.emit("close", 0);
			});
			return proc;
		});

		const result = await runTasks(
			[{ agent: "forker", task: "inspect fork", cwd: "pkg" }],
			forkExecutorContext(),
		);

		const run = result.details.results[0];
		expect(run).toMatchObject({
			contextMode: "fork",
			cwd: workspace,
			model: "test/test-model",
			tools: ["read", "subagent"],
			output: "fork done",
		});
		expect(capturedArgs).toEqual(expect.arrayContaining(["--fork", "--session-dir", "--session-id", "parent-session"]));
		expect(capturedArgs).not.toEqual(expect.arrayContaining(["--no-session", "--system-prompt"]));
		expect(capturedArgs.at(-1)).toContain("Inspect only the requested scope.");
		expect(capturedArgs.at(-1)).toContain("inspect fork");
		expect(capturedEnv).toMatchObject({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_FORK: "1" });
		const snapshotLines = snapshot.trim().split("\n").map((line) => JSON.parse(line) as { type: string; id?: string });
		expect(snapshotLines.map((entry) => entry.type)).toEqual(["session", "message"]);
		expect(snapshotLines[1]?.id).toBe("user-1");
		expect(snapshotPath).not.toBe("");
		await expect(readFile(snapshotPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fork 重试从同一 snapshot 创建独立 child session", async () => {
		await writeAgent("forker", "read", { fork: true, body: "Body." });
		await writeConfig({ retry_delay_ms: 0 });
		const snapshots: string[] = [];
		const sessionDirs: string[] = [];
		let calls = 0;
		setSubagentSpawnForTests((_command, args) => {
			calls += 1;
			const snapshotPath = args[args.indexOf("--fork") + 1];
			const sessionDir = args[args.indexOf("--session-dir") + 1];
			if (snapshotPath !== undefined) snapshots.push(snapshotPath);
			if (sessionDir !== undefined) sessionDirs.push(sessionDir);
			return calls === 1
				? completedProcess()
				: completedProcess(messageStart(), messageEnd([{ type: "text", text: "recovered" }]));
		});

		const result = await runTasks([{ agent: "forker", task: "retry" }], forkExecutorContext());

		expect(result.details.results[0]).toMatchObject({ attempts: 2, output: "recovered", contextMode: "fork" });
		expect(new Set(snapshots).size).toBe(1);
		expect(new Set(sessionDirs).size).toBe(2);
	});

	it("/run fork 从当前 leaf 保留最新 assistant 输出", async () => {
		const entries = [
			{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Question", timestamp: 1 } },
			{ type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-01T00:00:01.000Z", message: {
				role: "assistant",
				content: [{ type: "text", text: "Latest answer" }],
				api: "openai-completions",
				provider: "test",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			} },
		] satisfies SessionEntry[];
		const parent = context({
			sessionManager: {
				getSessionId: () => "parent-session",
				getLeafId: () => "assistant",
				getLeafEntry: () => entries[1],
				getEntries: () => entries,
			},
		});
		const fork = await createForkExecutionContext(parent);
		try {
			const snapshot = (await readFile(fork.snapshotPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id?: string });
			expect(snapshot.map((entry) => entry.id)).toEqual(["parent-session", "user", "assistant"]);
		} finally {
			await cleanupForkExecutionContext(fork);
		}
	});

	it("工具 fork 在前序顺序工具完成后仍从当前 assistant 之前分支", async () => {
		const entries = [
			{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Question", timestamp: 1 } },
			{ type: "message", id: "assistant-tools", parentId: "user", timestamp: "2026-01-01T00:00:01.000Z", message: assistantMessage([
				{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "echo ready" } },
				{ type: "toolCall", id: "subagent-call", name: "subagent", arguments: { tasks: [{ agent: "forker", task: "inspect" }] } },
			], "toolUse", wireUsage()) },
			{ type: "message", id: "bash-result", parentId: "assistant-tools", timestamp: "2026-01-01T00:00:02.000Z", message: {
				role: "toolResult",
				toolCallId: "bash-call",
				toolName: "bash",
				content: [{ type: "text", text: "ready" }],
				isError: false,
				timestamp: 3,
			} },
		] satisfies SessionEntry[];
		const fork = await createForkExecutionContext(forkExecutorContext({
			toolCallId: "subagent-call",
			sessionManager: {
				getSessionId: () => "parent-session",
				getLeafId: () => "bash-result",
				getLeafEntry: () => entries[2],
				getEntries: () => entries,
			},
		}));
		try {
			const snapshot = (await readFile(fork.snapshotPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id?: string });
			expect(snapshot.map((entry) => entry.id)).toEqual(["parent-session", "user"]);
		} finally {
			await cleanupForkExecutionContext(fork);
		}
	});

	it("工具 fork 在 spawn 前拒绝无法在当前分支定位的 tool call", async () => {
		await writeAgent("forker", "read", { fork: true });
		const spawn = vi.fn();
		setSubagentSpawnForTests(spawn);

		await expect(runTasks([{ agent: "forker", task: "inspect" }], forkExecutorContext({ toolCallId: "wrong-call" })))
			.rejects.toThrow("fork setup error");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("fork 临时资源使用私有权限并逐字保存 system prompt", async () => {
		const fork = await createForkExecutionContext(forkExecutorContext());
		try {
			if (process.platform !== "win32") {
				expect((await stat(path.dirname(fork.snapshotPath))).mode & 0o777).toBe(0o700);
				expect((await stat(fork.snapshotPath)).mode & 0o777).toBe(0o600);
				expect((await stat(fork.systemPromptPath)).mode & 0o777).toBe(0o600);
			}
			expect(await readFile(fork.systemPromptPath, "utf8")).toBe("Exact parent system prompt");
		} finally {
			await cleanupForkExecutionContext(fork);
		}
	});

	it("fork 缺少当前模型时在 spawn 前失败", async () => {
		await writeAgent("forker", "read", { fork: true, body: "Body." });
		const spawn = vi.fn();
		setSubagentSpawnForTests(spawn);

		await expect(runTasks([{ agent: "forker", task: "inspect" }], forkExecutorContext({ currentModel: undefined })))
			.rejects.toThrow("fork setup error");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("chain 将上一步输出传入 {previous}，失败时停止后续步骤", async () => {
		await writeConfig({ retry_delay_ms: 0 });
		expect(resolveMode([{ agent: "scout", task: "use {previous_result}" }])).toBe("parallel");
		setOutputSpawn((task) => task === "seed" ? "handoff" : task.includes("stop") ? undefined : `received ${task}`);
		const chain: NonEmptyArray<SubagentTask> = [{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }];
		const success = await runTasks(chain);
		expect(success.details.mode).toBe("chain");
		expect(success.details.results.map((item) => item.task)).toEqual(["seed", "use handoff"]);
		expect(success.details.results[1]?.output).toBe("received use handoff");

		const failed = await runTasks([{ agent: "scout", task: "stop" }, { agent: "scout", task: "never {previous}" }]);
		expect(failed.details.results).toEqual([
			expect.objectContaining({ task: "stop", error: "empty output" }),
		]);
	});

	it("超限输出持久化，并在 chain 中替换为文件引用", async () => {
		const largeOutput = "alpha beta gamma delta ".repeat(200);
		await constrainInlineOutput(largeOutput);
		setOutputSpawn((task) => task === "large" || task === "seed" ? largeOutput : `received ${task}`);

		const single = await runTasks([{ agent: "scout", task: "large" }]);
		const singleRun = single.details.results[0];
		if (singleRun?.status !== "completed") throw new Error("subagent did not complete");
		const singleOutputFile = singleRun.outputFile;
		expect(await readFile(singleOutputFile, "utf8")).toBe(largeOutput);
		const result = await runTasks([{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }]);
		const [persisted, handoff] = result.details.results;
		if (persisted?.status !== "completed") throw new Error("subagent did not complete");
		const outputFile = persisted.outputFile;
		expect(handoff?.task).toContain(outputFile);
		expect(handoff?.task).not.toContain(largeOutput);
	});

	it("只读空输出按策略重试并保留实际次数", async () => {
		await writeConfig({ retry_delay_ms: 0 });
		let calls = 0;
		setOutputSpawn(() => ++calls === 1 ? undefined : "recovered");

		const result = await runTasks([{ agent: "scout", task: "retry" }]);

		expect(calls).toBe(2);
		expect(result.details.results[0]).toMatchObject({ attempts: 2, output: "recovered" });
	});

	it("provider 瞬时失败不依赖空输出开关也会重试", async () => {
		await writeConfig({ retry_delay_ms: 0, retry_on_empty_output: false });
		let calls = 0;
		setSubagentSpawnForTests(() => {
			calls += 1;
			if (calls > 1) return completedProcess(messageStart(), messageEnd([{ type: "text", text: "recovered" }]));
			const proc = new FakeChildProcess();
			queueMicrotask(() => {
				proc.stderr.write("provider error: rate limit");
				proc.exitCode = 0;
				proc.emit("close", 0);
			});
			return proc;
		});

		const result = await runTasks([{ agent: "scout", task: "provider" }]);

		expect(calls).toBe(2);
		expect(result.details.results[0]).toMatchObject({ attempts: 2, output: "recovered" });
	});

	it("写能力任务失败后不重试", async () => {
		await writeAgent("worker", "read, edit");
		await writeConfig({ retry_delay_ms: 0 });
		let calls = 0;
		setOutputSpawn(() => {
			calls += 1;
			return undefined;
		});

		const result = await runTasks(
			[{ agent: "worker", task: "write once" }],
			context({
				allTools: [toolInfo("read"), toolInfo("edit")],
				interaction: { confirmWrite: async () => true },
			}),
		);

		expect(calls).toBe(1);
		expect(result.details.results[0]).toMatchObject({ attempts: 1, error: "empty output" });
	});

	it("损坏的 JSONL 明确失败且不重试", async () => {
		let calls = 0;
		setSubagentSpawnForTests(() => {
			calls++;
			const proc = new FakeChildProcess();
			queueMicrotask(() => {
				proc.stdout.write("not-json\n");
				proc.stdout.write(`${JSON.stringify(messageStart())}\n`);
				proc.stdout.write(`${JSON.stringify(messageEnd([{ type: "text", text: "done" }]))}\n`);
				proc.exitCode = 0;
				proc.emit("close", 0);
			});
			return proc;
		});

		const result = await runTasks([{ agent: "scout", task: "protocol" }]);

		expect(calls).toBe(1);
		expect(result.details.results[0]).toMatchObject({ error: "Pi JSON protocol error: 1 malformed event" });
	});

	it("preflight 统一拒绝未知 agent、越界 cwd 和未确认的写能力", async () => {
		await writeAgent("worker", "read, edit");
		const spawn = vi.fn();
		setSubagentSpawnForTests(spawn);

		await expect(runTasks([{ agent: "missing", task: "x" }])).rejects.toThrow("missing");
		await expect(runTasks([
			{ agent: "scout", task: "valid" },
			{ agent: "scout", task: "invalid", cwd: ".." },
		])).rejects.toThrow("cwd");
		await expect(runTasks(
			[{ agent: "worker", task: "write" }],
			context({ allTools: [toolInfo("read"), toolInfo("edit")] }),
		)).rejects.toThrow("confirmation");
		await expect(runTasks(
			[{ agent: "worker", task: "write" }],
			context({
				allTools: [toolInfo("read"), toolInfo("edit")],
				interaction: { confirmWrite: async () => false },
			}),
		)).rejects.toThrow("Canceled");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("RPC dialog adapter 可通过窄 interaction port 确认写权限", async () => {
		await writeAgent("worker", "read, edit");
		setOutputSpawn(() => "write approved");
		const confirmWrite = vi.fn(async () => true);

		const result = await runTasks(
			[{ agent: "worker", task: "update files" }],
			context({
				allTools: [toolInfo("read"), toolInfo("edit")],
				interaction: { confirmWrite },
			}),
		);

		expect(result.details.results[0]?.output).toBe("write approved");
		expect(confirmWrite).toHaveBeenCalledOnce();
	});

	it("解析 message_update delta 并发送实时进度快照", async () => {
		setSubagentSpawnForTests(() => completedProcess(
			messageStart(),
			messageUpdate({ input: 12, output: 0, totalTokens: 12 }, { type: "text_start", contentIndex: 0 }),
			messageUpdate({ input: 12, output: 1, totalTokens: 13 }, { type: "text_delta", contentIndex: 0, delta: "work" }),
			messageUpdate({ input: 12, output: 2, totalTokens: 14 }, { type: "text_delta", contentIndex: 0, delta: "ing" }),
			messageEnd([{ type: "text", text: "done" }], { input: 12, output: 3, totalTokens: 15 }),
		));
		const updates: ProcessRunProgress[] = [];

		const output = await runPiProcess(input(), { onUpdate: (progress) => updates.push(progress) });

		expect(updates.some((update) => update.output === "work" && update.usage.output === 1)).toBe(true);
		expect(output).toMatchObject({
			output: "done",
			usage: { input: 12, output: 3, contextTokens: 15, turns: 1 },
			events: [{ type: "text", text: "done" }],
		});
	});

	it("累计流式 usage 只取当前 turn 最新快照，完成后再跨 turn 求和", () => {
		const progress = new PiJsonProgressAccumulator();
		progress.consume(messageStart());
		progress.consume(messageUpdate({ input: 10, output: 1, totalTokens: 11 }, { type: "thinking_delta", contentIndex: 0, delta: "a" }));
		progress.consume(messageUpdate({ input: 10, output: 4, totalTokens: 14 }, { type: "thinking_delta", contentIndex: 0, delta: "b" }));

		expect(progress.snapshot().usage).toMatchObject({ input: 10, output: 4, contextTokens: 14, turns: 1 });

		progress.consume(messageEnd([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], { input: 10, output: 5, totalTokens: 15 }));
		progress.consume(messageStart());
		progress.consume(messageUpdate({ input: 20, output: 0, cacheRead: 3, totalTokens: 23 }, { type: "text_start", contentIndex: 0 }));
		progress.consume(messageUpdate({ input: 20, output: 2, cacheRead: 3, totalTokens: 25 }, { type: "text_delta", contentIndex: 0, delta: "done" }));

		expect(progress.snapshot().usage).toMatchObject({
			input: 30,
			output: 7,
			cacheRead: 3,
			contextTokens: 25,
			turns: 2,
		});
	});

	it("从 toolcall_start 立即展示工具，再按执行生命周期更新状态", () => {
		const progress = new PiJsonProgressAccumulator();
		progress.consume(messageStart());
		progress.consume(messageUpdate(
			{ input: 1, output: 1, totalTokens: 2 },
			{ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "edit" },
		));
		expect(progress.snapshot()).toMatchObject({
			wrote: true,
			events: [{ type: "tool", name: "edit", args: {}, status: "pending" }],
		});

		progress.consume(messageUpdate(
			{ input: 1, output: 2, totalTokens: 3 },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts", edits: [] } },
			},
		));
		expect(progress.snapshot().events[0]).toMatchObject({
			type: "tool",
			name: "edit",
			args: { path: "a.ts", edits: [] },
			status: "pending",
		});

		progress.consume({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "a.ts", edits: [] } } as JsonAgentSessionEvent);
		expect(progress.snapshot().events[0]).toMatchObject({ type: "tool", name: "edit", status: "running" });

		progress.consume({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: {}, isError: false } as JsonAgentSessionEvent);
		expect(progress.snapshot().events[0]).toMatchObject({ type: "tool", name: "edit", status: "completed" });
	});

	it("正常退出和取消均清理进程资源", async () => {
		setOutputSpawn(() => "done");
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");

		await runPiProcess(input(), { signal: controller.signal });

		expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

		vi.useFakeTimers();
		const aborted = new AbortController();
		aborted.abort();

		const result = await runPiProcess(input(), { signal: aborted.signal });

		expect(result.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

type CommandExecutorContext = Extract<ExecutorContext, { invocation: "command" }>;
type ToolExecutorContext = Extract<ExecutorContext, { invocation: "tool" }>;

function forkExecutorContext(overrides: Partial<Omit<ToolExecutorContext, "invocation">> = {}): ToolExecutorContext {
	const entries = [
		{ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Parent request", timestamp: 1 } },
		{ type: "custom", id: "custom-1", parentId: "user-1", timestamp: "2026-01-01T00:00:01.000Z", customType: "ui", data: { hidden: true } },
		{ type: "message", id: "assistant-call", parentId: "custom-1", timestamp: "2026-01-01T00:00:02.000Z", message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks: [] } }],
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		} },
		{ type: "message", id: "sibling", parentId: "user-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "Sibling", timestamp: 3 } },
	] satisfies SessionEntry[];
	const { toolCallId = "call-1", ...contextOverrides } = overrides;
	return {
		cwd: workspace,
		currentModel: testModel(),
		activeTools: ["read", "subagent"],
		allTools: [toolInfo("read"), toolInfo("subagent")],
		thinkingLevel: "medium",
		systemPrompt: "Exact parent system prompt",
		sessionManager: {
			getSessionId: () => "parent-session",
			getLeafId: () => "assistant-call",
			getLeafEntry: () => entries[2],
			getEntries: () => entries,
		},
		...contextOverrides,
		invocation: "tool",
		toolCallId,
	};
}

function toolInfo(name: string): NonNullable<Parameters<typeof executeSubagent>[1]["allTools"]>[number] {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
	};
}

function context(overrides: Partial<Omit<CommandExecutorContext, "invocation" | "toolCallId">> = {}): CommandExecutorContext {
	return {
		cwd: workspace,
		currentModel: testModel(),
		activeTools: ["read"],
		allTools: [toolInfo("read")],
		thinkingLevel: "off",
		sessionManager: emptySessionManager(),
		systemPrompt: "Parent system prompt",
		...overrides,
		invocation: "command",
	};
}

function runTasks(
	tasks: Parameters<typeof executeSubagent>[0]["tasks"],
	executionContext: Parameters<typeof executeSubagent>[1] = context(),
): ReturnType<typeof executeSubagent> {
	return executeSubagent({ tasks }, executionContext);
}

async function writeAgent(
	name: string,
	tools: string,
	options: { body?: string; fork?: boolean; model?: string } = {},
): Promise<void> {
	const frontmatter = [
		"---",
		`name: ${name}`,
		`description: ${name}`,
		...(options.fork === true ? ["fork: true"] : []),
		...(options.model === undefined ? [] : [`model: ${options.model}`]),
		`tools: ${tools}`,
		"---",
		options.body ?? "Follow the task.",
	];
	await writeFile(
		path.join(workspace, "agent", "agents", `${name}.md`),
		frontmatter.join("\n"),
	);
}

function setOutputSpawn(outputForTask: (task: string) => string | undefined): void {
	setSubagentSpawnForTests((_command, args) => {
		const task = args.at(-1)?.replace(/^Task: /, "") ?? "";
		const output = outputForTask(task);
		return output === undefined
			? completedProcess()
			: completedProcess(messageStart(), messageEnd([{ type: "text", text: output }]));
	});
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	const configPath = process.env.PI_SUBAGENT_USER_CONFIG;
	if (configPath === undefined) throw new Error("subagent config path missing");
	await writeFile(configPath, JSON.stringify(config));
}

async function constrainInlineOutput(output: string): Promise<void> {
	const max_inline_output_tokens = countTextTokensSync(output, { modelId: "test-model" }).tokens - 1;
	expect(max_inline_output_tokens).toBeGreaterThanOrEqual(250);
	await writeConfig({ max_inline_output_tokens });
}

function completedProcess(...messages: unknown[]): FakeChildProcess {
	const proc = new FakeChildProcess();
	queueMicrotask(() => {
		for (const message of messages) proc.stdout.write(`${JSON.stringify(message)}\n`);
		proc.exitCode = 0;
		proc.emit("close", 0);
	});
	return proc;
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

type JsonMessageUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

function messageStart(): JsonAgentSessionEvent {
	return { type: "message_start", message: assistantMessage([], "pending", wireUsage()) };
}

function messageUpdate(
	usage: Partial<Usage>,
	assistantMessageEvent: JsonMessageUpdate["assistantMessageEvent"],
): JsonMessageUpdate {
	return { type: "message_update", usage: wireUsage(usage), assistantMessageEvent };
}

function messageEnd(
	content: AssistantMessage["content"],
	usage: Partial<Usage> = { input: 1, output: 1, totalTokens: 2 },
): JsonAgentSessionEvent {
	return { type: "message_end", message: assistantMessage(content, "stop", wireUsage(usage)) };
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		content,
		stopReason,
		usage,
		timestamp: 1,
	};
}

function wireUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function input(): ProcessRunInput {
	return {
		contextMode: "isolated",
		runId: "run-1",
		mode: "parallel",
		agent: agent(),
		task: "inspect renderer",
		cwd: process.cwd(),
		tools: ["read"],
		timeoutMs: 1000,
	};
}

function testModel(): NonNullable<Parameters<typeof executeSubagent>[1]["currentModel"]> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function emptySessionManager() {
	return {
		getSessionId: () => "session-1",
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntries: () => [],
	};
}

function agent(): AgentDefinition {
	return {
		name: "scout",
		description: "Scout",
		body: "Follow the task.",
		fork: false,
		tools: ["read"],
		source: "user",
		filePath: path.resolve("agents", "scout.md"),
	};
}
