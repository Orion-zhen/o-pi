import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentCommand } from "../../src/subagent/commands.js";
import { executeSubagent, resolveMode } from "../../src/subagent/executor.js";
import { resetSubagentSpawnForTests, runPiProcess, setSubagentSpawnForTests } from "../../src/subagent/process.js";
import {
	cleanupForkExecutionContext,
	createForkExecutionContext,
	loadAndValidateForkSystemPrompt,
	validateForkRuntime,
} from "../../src/subagent/session-context.js";
import type {
	AgentDefinition,
	ProcessRunInput,
	ProcessRunProgress,
	SubagentProgressEvent,
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
	await writeConfig({ retry_delay_ms: 0 });
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
			return completedProcess(messageEnd([{ type: "text", text: "done" }]));
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
			retry_delay_ms: 0,
			default_model: "ignored/default",
			agent_overrides: { forker: { model: "ignored/override", tools: ["write"] } },
		});
		let capturedArgs: readonly string[] = [];
		let capturedEnv: NodeJS.ProcessEnv | undefined;
		let snapshot = "";
		setSubagentSpawnForTests((_command, args, options) => {
			capturedArgs = args;
			capturedEnv = options.env;
			const proc = new FakeChildProcess();
			queueMicrotask(async () => {
				const snapshotPath = options.env?.PI_SUBAGENT_FORK_SNAPSHOT;
				if (snapshotPath !== undefined) snapshot = await readFile(snapshotPath, "utf8");
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
		const snapshotPath = capturedEnv?.PI_SUBAGENT_FORK_SNAPSHOT;
		if (snapshotPath === undefined) throw new Error("fork snapshot path was not captured");
		await expect(readFile(snapshotPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fork retry 每次从同一 snapshot 创建独立 child session", async () => {
		await writeAgent("forker", "read", { fork: true, body: "Body." });
		const snapshots: string[] = [];
		const sessionDirs: string[] = [];
		let calls = 0;
		setSubagentSpawnForTests((_command, args) => {
			calls++;
			const forkIndex = args.indexOf("--fork");
			const sessionDirIndex = args.indexOf("--session-dir");
			const snapshotPath = args[forkIndex + 1];
			const sessionDir = args[sessionDirIndex + 1];
			if (forkIndex >= 0 && snapshotPath !== undefined) snapshots.push(snapshotPath);
			if (sessionDirIndex >= 0 && sessionDir !== undefined) sessionDirs.push(sessionDir);
			return calls === 2
				? completedProcess(messageEnd([{ type: "text", text: "recovered" }]))
				: completedProcess();
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
		const parent = forkExecutorContext({
			invocation: "command",
			toolCallId: undefined,
			sessionManager: {
				getSessionId: () => "parent-session",
				getLeafId: () => "assistant",
				getLeafEntry: () => entries[1],
				getEntries: () => entries,
				getHeader: () => null,
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

	it("manifest 诊断检查 system、model、tools、thinking、session 和 cwd", async () => {
		const parent = forkExecutorContext();
		const fork = await createForkExecutionContext(parent);
		const valid = {
			manifestPath: fork.manifestPath,
			snapshotPath: fork.snapshotPath,
			model: fork.model,
			activeTools: fork.activeTools,
			allTools: fork.allTools,
			thinkingLevel: fork.thinkingLevel,
			sessionId: fork.sessionId,
			cwd: fork.cwd,
		};
		try {
			if (process.platform !== "win32") {
				expect((await stat(path.dirname(fork.snapshotPath))).mode & 0o777).toBe(0o700);
				expect((await stat(fork.snapshotPath)).mode & 0o777).toBe(0o600);
				expect((await stat(fork.systemPromptPath)).mode & 0o777).toBe(0o600);
				expect((await stat(fork.manifestPath)).mode & 0o777).toBe(0o600);
			}
			await expect(validateForkRuntime(valid)).resolves.toBeUndefined();
			const mismatches = [
				{ model: { ...fork.model, baseUrl: "https://other.invalid" } },
				{ activeTools: [...fork.activeTools].reverse() },
				{ allTools: fork.allTools.map((tool) => tool.name === "read" ? { ...tool, description: "changed" } : tool) },
				{ thinkingLevel: "off" },
				{ sessionId: "other-session" },
				{ cwd: path.join(workspace, "other") },
			] satisfies Array<Partial<Parameters<typeof validateForkRuntime>[0]>>;
			await Promise.all(mismatches.map((mismatch) => expect(validateForkRuntime({ ...valid, ...mismatch })).rejects.toThrow()));
			await expect(loadAndValidateForkSystemPrompt(fork.systemPromptPath, fork.manifestPath)).resolves.toBe("Exact parent system prompt");
			await writeFile(fork.systemPromptPath, "tampered prompt");
			await expect(loadAndValidateForkSystemPrompt(fork.systemPromptPath, fork.manifestPath)).rejects.toThrow();
		} finally {
			await cleanupForkExecutionContext(fork);
		}
	});

	it("fork 边界不匹配时在 spawn 前失败", async () => {
		await writeAgent("forker", "read", { fork: true, body: "Body." });
		const spawn = vi.fn();
		setSubagentSpawnForTests(spawn);

		const result = await runTasks([{ agent: "forker", task: "inspect" }], forkExecutorContext({ toolCallId: "wrong-call" }));

		expect(result.details.results).toEqual([]);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("chain 将上一步输出传入 {previous}，失败时停止后续步骤", async () => {
		expect(resolveMode([{ agent: "scout", task: "use {previous_result}" }])).toBe("parallel");
		setOutputSpawn((task) => task === "seed" ? "handoff" : task.includes("stop") ? undefined : `received ${task}`);
		const chain = [{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }];
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
		const singleOutputFile = single.details.results[0]?.outputFile;
		if (singleOutputFile === undefined) throw new Error("subagent output file missing");
		expect(await readFile(singleOutputFile, "utf8")).toBe(largeOutput);
		const result = await runTasks([{ agent: "scout", task: "seed" }, { agent: "scout", task: "use {previous}" }]);
		const [persisted, handoff] = result.details.results;
		const outputFile = persisted?.outputFile;
		if (outputFile === undefined) throw new Error("subagent output file missing");
		expect(handoff?.task).toContain(outputFile);
		expect(handoff?.task).not.toContain(largeOutput);
	});

	it("只读失败会重试，成功后保留实际 attempts", async () => {
		let calls = 0;
		setOutputSpawn(() => ++calls === 1 ? undefined : "recovered");

		const result = await runTasks([{ agent: "scout", task: "retry" }]);

		expect(calls).toBe(2);
		expect(result.details.results[0]).toMatchObject({ attempts: 2, output: "recovered" });
	});

	it("统一拒绝空任务、未知 agent、越界 cwd 和未确认的写能力", async () => {
		await writeAgent("worker", "read, edit");
		const spawn = vi.fn();
		setSubagentSpawnForTests(spawn);
		const cases = [
			await runTasks([]),
			await runTasks([{ agent: "missing", task: "x" }]),
			await runTasks([{ agent: "scout", task: "x", cwd: ".." }]),
			await runTasks([{ agent: "worker", task: "write" }], context({ allTools: [toolInfo("read"), toolInfo("edit")] })),
			await runTasks(
				[{ agent: "worker", task: "write" }],
				context({
					allTools: [toolInfo("read"), toolInfo("edit")],
					interaction: { confirmWrite: async () => false },
				}),
			),
		];

		expect(cases.map(({ content }) => content[0])).toEqual([
			expect.objectContaining({ text: expect.stringMatching(/\btasks\b/i) }),
			expect.objectContaining({ text: expect.stringMatching(/\bmissing\b/i) }),
			expect.objectContaining({ text: expect.stringMatching(/\bcwd\b/i) }),
			expect.objectContaining({ text: expect.stringMatching(/\bconfirmation\b/i) }),
			expect.objectContaining({ text: expect.stringMatching(/\bcanceled\b/i) }),
		]);
		expect(cases.every((result) => result.details.results.length === 0)).toBe(true);
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

	it("解析 JSONL 时发送实时进度快照", async () => {
		setSubagentSpawnForTests(() => completedProcess(
			messageEnd([{ type: "toolCall", name: "read", arguments: { path: "src/subagent/tui/renderer.ts" } }]),
			messageEnd([{ type: "text", text: "done" }]),
		));
		const updates: ProcessRunProgress[] = [];

		const output = await runPiProcess(input(), { onUpdate: (progress) => updates.push(progress) });

		expect(output.output).toBe("done");
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]?.events).toEqual([{ type: "tool", name: "read", args: { path: "src/subagent/tui/renderer.ts" } }]);
		expect(updates.at(-1)?.events.at(-1)).toEqual({ type: "text", text: "done" });
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

function forkExecutorContext(overrides: Partial<Parameters<typeof executeSubagent>[1]> = {}): Parameters<typeof executeSubagent>[1] {
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
	return context({
		activeTools: ["read", "subagent"],
		allTools: [toolInfo("read"), toolInfo("subagent")],
		thinkingLevel: "medium",
		systemPrompt: "Exact parent system prompt",
		invocation: "tool",
		toolCallId: "call-1",
		sessionManager: {
			getSessionId: () => "parent-session",
			getLeafId: () => "assistant-call",
			getLeafEntry: () => entries[2],
			getEntries: () => entries,
			getHeader: () => null,
		},
		...overrides,
	});
}

function toolInfo(name: string): NonNullable<Parameters<typeof executeSubagent>[1]["allTools"]>[number] {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
	};
}

function context(overrides: Partial<Parameters<typeof executeSubagent>[1]> = {}): Parameters<typeof executeSubagent>[1] {
	return {
		cwd: workspace,
		currentModel: testModel(),
		allTools: [toolInfo("read")],
		...overrides,
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
			: completedProcess(messageEnd([{ type: "text", text: output }]));
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
	await writeConfig({ retry_delay_ms: 0, max_inline_output_tokens });
}

function completedProcess(...messages: Array<Record<string, unknown>>): FakeChildProcess {
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
		contextMode: "isolated",
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
		getHeader: () => null,
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
		hasWriteCapability: false,
	};
}
