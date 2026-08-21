import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => {
	const instances: MockClient[] = [];
	let nextLoginError: Error | undefined;
	class MockClient {
		isConnected = false;
		readonly activities: unknown[] = [];
		clearCount = 0;
		destroyCount = 0;
		failSet = false;
		private readonly listeners = new Map<string, Array<() => void>>();
		readonly user = {
			setActivity: async (activity: unknown) => {
				if (this.failSet) throw new Error("set failed");
				this.activities.push(activity);
			},
			clearActivity: async () => {
				this.clearCount += 1;
			},
		};
		constructor(readonly options: unknown) {
			instances.push(this);
		}
		on(event: string, listener: () => void): this {
			const current = this.listeners.get(event) ?? [];
			current.push(listener);
			this.listeners.set(event, current);
			return this;
		}
		async login(): Promise<void> {
			if (nextLoginError !== undefined) {
				const error = nextLoginError;
				nextLoginError = undefined;
				throw error;
			}
			this.isConnected = true;
		}
		async destroy(): Promise<void> {
			this.destroyCount += 1;
			this.isConnected = false;
		}
		disconnect(): void {
			this.isConnected = false;
			for (const listener of this.listeners.get("disconnected") ?? []) listener();
		}
	}
	return {
		MockClient,
		instances,
		failNextLogin(error: Error) {
			nextLoginError = error;
		},
	};
});

vi.mock("@xhayper/discord-rpc", () => ({ Client: discordMock.MockClient }));

import { createDiscordPresenceExtension } from "../../agent/extensions/discord-presence.js";
import {
	classifyTool,
	currentActivity,
	endTool,
	initialPresenceActivityState,
	stableExecutableFromCommand,
	startTool,
	startTurn,
	updateTool,
} from "../../src/discord-presence/activity.js";
import {
	DiscordPresenceConfigError,
	defaultDiscordPresenceConfig,
	loadDiscordPresenceConfig,
} from "../../src/discord-presence/config.js";
import { PresencePublisher } from "../../src/discord-presence/publisher.js";
import { renderDiscordActivity, renderTemplate } from "../../src/discord-presence/render.js";
import { DiscordPresenceService } from "../../src/discord-presence/service.js";
import {
	completedTopLevelStringProperty,
	StreamingToolCallTracker,
} from "../../src/discord-presence/streaming.js";
import { createDiscordRpcTransport, type DiscordPresenceTransport } from "../../src/discord-presence/transport.js";
import type {
	DiscordActivityPayload,
	DiscordPresenceConfig,
	PresenceProfileConfig,
} from "../../src/discord-presence/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-discord-presence-");
preserveEnv(
	"PI_DISCORD_PRESENCE_CONFIG",
	"PI_DISCORD_PRESENCE_PROJECT_CONFIG",
	"PI_DISCORD_PRESENCE_PROJECT_ROOT",
);

beforeEach(() => {
	discordMock.instances.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function enabledConfig(): DiscordPresenceConfig {
	const config = defaultDiscordPresenceConfig();
	config.enabled = true;
	config.application_id = "123456789012345678";
	config.profile = "detailed";
	const detailed = configuredProfile(config, "detailed");
	detailed.details.idle = "Waiting in {project}";
	detailed.details.reading = "Reading {file}";
	detailed.details.editing = "Editing {file}";
	detailed.state = "{project} · {model}";
	const minimal = configuredProfile(config, "minimal");
	minimal.details.idle = "Waiting for input";
	minimal.state = "Pi Coding Agent";
	return config;
}

function configuredProfile(config: DiscordPresenceConfig, name: string): PresenceProfileConfig {
	const profile = config.profiles[name];
	if (profile === undefined) throw new Error(`Missing test profile: ${name}`);
	return profile;
}

class FakeTransport implements DiscordPresenceTransport {
	readonly activities: DiscordActivityPayload[] = [];
	clearCount = 0;
	closeCount = 0;
	failSetCount = 0;
	status: ReturnType<DiscordPresenceTransport["getStatus"]> = "disconnected";
	private readonly listeners = new Set<(status: ReturnType<DiscordPresenceTransport["getStatus"]>) => void>();

	async setActivity(activity: DiscordActivityPayload): Promise<void> {
		if (this.failSetCount > 0) {
			this.failSetCount -= 1;
			this.status = "disconnected";
			throw new Error("Discord unavailable");
		}
		this.status = "connected";
		this.activities.push(activity);
	}
	async clearActivity(): Promise<void> {
		this.clearCount += 1;
	}
	async close(): Promise<void> {
		this.status = "disabled";
		this.closeCount += 1;
	}
	getStatus() {
		return this.status;
	}
	onStatus(listener: (status: ReturnType<DiscordPresenceTransport["getStatus"]>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emitStatus(status: ReturnType<DiscordPresenceTransport["getStatus"]>): void {
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}
}

describe("Discord presence 配置", () => {
	it("读取默认值，并支持用户与项目稀疏覆盖", async () => {
		const userConfig = path.join(temp.path, "user.jsonc");
		const projectRoot = path.join(temp.path, "project");
		const projectConfig = path.join(projectRoot, ".pi", "configs", "discord-presence.jsonc");
		await mkdir(path.dirname(projectConfig), { recursive: true });
		await writeFile(userConfig, `{
			"enabled": true,
			"application_id": "123456789012345678",
			"profile": "standard",
			"profiles": { "standard": { "details": { "thinking": "Considering options" } } }
		}`);
		await writeFile(projectConfig, '{ "profile": "minimal" }');
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = userConfig;

		const config = await loadDiscordPresenceConfig(projectRoot);

		const defaults = defaultDiscordPresenceConfig();
		expect(defaults).toMatchObject({
			enabled: true,
			application_id: "1520833162148712580",
			update_interval_ms: 5_000,
			retry_interval_ms: 30_000,
			profile: "standard",
		});
		expect(configuredProfile(defaults, "minimal").details).toEqual({
			idle: "Waiting for input",
			thinking: "Thinking",
		});
		expect(config).toMatchObject({
			enabled: true,
			application_id: "123456789012345678",
			profile: "minimal",
		});
		const standard = configuredProfile(config, "standard");
		expect(standard.details).toEqual({ thinking: "Considering options" });
	});

	it("支持选择用户定义的 profile", async () => {
		const configPath = path.join(temp.path, "custom-profile.jsonc");
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = configPath;
		await writeFile(configPath, `{
			"profile": "focus",
			"profiles": {
				"focus": {
					"details": { "thinking": "憋个大的", "editing": "施工 {file}" },
					"state": "{project}",
					"show_elapsed": true
				}
			}
		}`);

		const config = await loadDiscordPresenceConfig(temp.path);

		expect(config.profile).toBe("focus");
		expect(configuredProfile(config, "focus")).toMatchObject({
			details: { thinking: "憋个大的", editing: "施工 {file}" },
			state: "{project}",
			show_elapsed: true,
		});
	});

	it("拒绝启用时缺少 Application ID、未知 profile 或未知模板占位符", async () => {
		const configPath = path.join(temp.path, "invalid.jsonc");
		process.env["PI_DISCORD_PRESENCE_CONFIG"] = configPath;
		await writeFile(configPath, '{ "enabled": true, "application_id": "" }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("application_id is required");

		await writeFile(configPath, '{ "update_interval_ms": 4999 }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("does not match schema");

		await writeFile(configPath, '{ "retry_interval_ms": 4999 }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("does not match schema");

		await writeFile(configPath, '{ "profile": "missing" }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toThrow("profile does not exist");

		await writeFile(configPath, '{ "profiles": { "minimal": { "state": "{secret}" } } }');
		await expect(loadDiscordPresenceConfig(temp.path)).rejects.toMatchObject({
			name: "DiscordPresenceConfigError",
			details: { path: "profiles.minimal.state", placeholder: "secret" },
		} satisfies Partial<DiscordPresenceConfigError>);
	});
});

describe("Discord presence 活动与渲染", () => {
	it.each([
		["read", { path: "/repo/src/main.ts" }, { kind: "reading", file: "main.ts", language: "TypeScript" }],
		["edit", { path: "README.md" }, { kind: "editing", file: "README.md", language: "Markdown" }],
		["write", { path: "main.rs" }, { kind: "writing", file: "main.rs", language: "Rust" }],
		["grep", { query: "secret" }, { kind: "searching" }],
		["websearch", { query: "private query" }, { kind: "browsing" }],
		["bash", { command: "TOKEN=x /usr/bin/git status --secret" }, { kind: "shell", executable: "git" }],
		["custom", { value: "private" }, { kind: "other_tool", tool: "custom" }],
	] as const)("将 %s 分类且只保留安全目标", (tool, args, expected) => {
		expect(classifyTool(tool, args)).toMatchObject(expected);
	});

	it("并行工具按 toolCallId 恢复上一活动，并在无工具时回到思考", () => {
		let state = startTurn(initialPresenceActivityState());
		state = startTool(state, "read-1", "read", { path: "a.ts" });
		state = startTool(state, "bash-1", "bash", { command: "npm test" });
		expect(currentActivity(state)).toMatchObject({ kind: "shell", executable: "npm" });
		state = endTool(state, "bash-1");
		expect(currentActivity(state)).toMatchObject({ kind: "reading", file: "a.ts" });
		state = endTool(state, "read-1");
		expect(currentActivity(state)).toMatchObject({ kind: "thinking" });
	});

	it("只在 path 字符串闭合和首个 Shell word 完成后 one-shot 提取元数据", () => {
		const fileTracker = new StreamingToolCallTracker();
		fileTracker.start("message", 0, { id: "write-1", name: "write", arguments: {} });
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/ind" },
		}, '{"path":"/private/src/ind')).toBeUndefined();
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/index.ts" },
		}, 'ex.ts","content":"{\\"path\\":\\"fake.ts\\"}')).toMatchObject({
			toolCallId: "write-1",
			args: { path: "/private/src/index.ts" },
		});
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/index.ts" },
		}, " more content")).toBeUndefined();

		const shellTracker = new StreamingToolCallTracker();
		shellTracker.start("message", 1, { id: "bash-1", name: "bash", arguments: {} });
		expect(shellTracker.delta("message", 1, {
			id: "bash-1", name: "bash", arguments: { command: "NODE_ENV=test np" },
		}, '{"command":"NODE_ENV=test np')).toBeUndefined();
		expect(shellTracker.delta("message", 1, {
			id: "bash-1", name: "bash", arguments: { command: "NODE_ENV=test npm run test" },
		}, "m run test")).toMatchObject({ args: { command: "NODE_ENV=test npm run test" } });
		expect(stableExecutableFromCommand("NODE_ENV=test npm run test", false)).toBe("npm");
		expect(stableExecutableFromCommand("pwd", false)).toBeUndefined();
		expect(stableExecutableFromCommand("pwd", true)).toBe("pwd");
	});

	it("流式 ID 替换和执行兜底不会覆盖已稳定的文件名", () => {
		let state = startTurn(initialPresenceActivityState());
		state = updateTool(state, "stream:message:0", "stream:message:0", "edit", {});
		state = updateTool(state, "stream:message:0", "edit-1", "edit", { path: "/private/a.ts" });
		state = startTool(state, "edit-1", "edit", { path: "/private/b.ts" });
		expect(currentActivity(state)).toMatchObject({ kind: "editing", file: "a.ts", language: "TypeScript" });
	});

	it("只识别顶层完整 path，且空 basename 不回退到完整路径", () => {
		expect(completedTopLevelStringProperty(
			'{"content":"{\\"path\\":\\"fake.ts\\"}","path":"src/a\\"b.ts"',
			"path",
		)).toBe('src/a"b.ts');
		expect(completedTopLevelStringProperty('{"path":"src/partial', "path")).toBeUndefined();
		expect(classifyTool("read", { path: "/private/" })).not.toHaveProperty("file");
	});

	it("按 profile、模板和资源优先级渲染，并安全截断单行文本", () => {
		const config = enabledConfig();
		config.assets.large = { key: "pi_logo", text: "Pi\nCoding Agent" };
		config.assets.small.text = "{label}";
		config.assets.small.default = "default";
		config.assets.small.activities.editing = "edit";
		config.assets.small.languages.typescript = "ts";
		const payload = renderDiscordActivity(
			config,
			"detailed",
			classifyTool("edit", { path: "/private/repo/example.ts" }),
			{ project: "o-pi", model: "GPT", session: "Presence", startedAt: 123 },
		);

		expect(payload).toEqual({
			details: "Editing example.ts",
			state: "o-pi · GPT",
			startTimestamp: 123,
			largeImageKey: "pi_logo",
			largeImageText: "Pi Coding Agent",
			smallImageKey: "ts",
			smallImageText: "TypeScript",
			instance: false,
		});
		expect(renderDiscordActivity(
			config,
			"minimal",
			classifyTool("edit", { path: "ignored.ts" }),
			{ project: "o-pi", model: "GPT", session: "Presence", startedAt: 123 },
		)).toBeUndefined();
		expect(renderTemplate("x".repeat(140), {
			project: "", model: "", session: "", file: "", language: "", executable: "", tool: "", label: "",
		})).toHaveLength(128);
	});
});

describe("Discord presence publisher", () => {
	it("首个状态立即发送，后续状态合并、去重，并在失败后重试最新值", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		const idle = { details: "Idle", instance: false } as const;
		const reading = { details: "Reading a.ts", instance: false } as const;
		const thinking = { details: "Thinking", instance: false } as const;

		publisher.request(idle);
		await vi.waitFor(() => expect(transport.activities).toEqual([idle]));
		publisher.request(idle);
		expect(transport.activities).toEqual([idle]);

		publisher.request(reading);
		publisher.request(thinking);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities).toEqual([idle, thinking]);

		transport.failSetCount = 1;
		publisher.request(reading);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities).toEqual([idle, thinking]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities).toEqual([idle, thinking, reading]);

		publisher.request(thinking);
		publisher.stop();
		publisher.stop();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities).toEqual([idle, thinking, reading]);
	});

	it("使用配置的最小更新间隔", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 5_000, 30_000);
		publisher.request({ details: "Idle", instance: false });
		expect(transport.activities).toHaveLength(1);
		await Promise.resolve();
		publisher.request({ details: "Thinking", instance: false });
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Thinking" });
		publisher.stop();
	});

	it("使用配置的失败重试间隔", async () => {
		const transport = new FakeTransport();
		transport.failSetCount = 1;
		const publisher = new PresencePublisher(transport, 5_000, 7_000);
		publisher.request({ details: "Idle", instance: false });
		expect(transport.failSetCount).toBe(0);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(6_999);
		expect(transport.activities).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Idle" });
		publisher.stop();
	});

	it("断线通知会使等待中的相同状态重新进入发送队列", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		const activity = { details: "Thinking", instance: false } as const;
		publisher.request(activity);
		await vi.waitFor(() => expect(transport.activities).toHaveLength(1));
		publisher.request({ details: "Reading", instance: false });
		transport.emitStatus("disconnected");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Reading" });
		publisher.stop();
	});
});

describe("Discord presence 服务与 Pi 适配", () => {
	it("合并快速事件、切换 profile，并在 settled 与 shutdown 时更新和清理", async () => {
		const transport = new FakeTransport();
		const service = new DiscordPresenceService({
			loadConfig: async () => enabledConfig(),
			createTransport: async () => transport,
			now: Date.now,
		});
		await service.startSession({
			cwd: "/workspace/o-pi",
			model: { id: "gpt", name: "GPT" },
			sessionName: "Rich Presence",
			idle: true,
		});
		await vi.waitFor(() => expect(transport.activities).toHaveLength(1));
		expect(transport.activities[0]).toMatchObject({ details: "Waiting in o-pi" });

		service.onTurnStart();
		service.onToolStart("read", "read", { path: "/secret/file.ts" });
		service.onToolStart("bash", "bash", { command: "git status --private" });
		service.onToolEnd("bash");
		service.onModelSelect({ id: "new", name: "New Model" });
		service.onSessionName("Renamed");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Reading file.ts", state: "o-pi · New Model" });

		const sentBeforeMinimal = transport.activities.length;
		service.selectProfile("minimal");
		service.onToolStart("bash-minimal", "bash", { command: "npm test" });
		service.onToolEnd("bash-minimal");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities).toHaveLength(sentBeforeMinimal);
		service.onAgentSettled();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Waiting for input", state: "Pi Coding Agent" });
		expect(transport.activities.at(-1)).not.toHaveProperty("startTimestamp");
		expect(service.status()).toMatchObject({ enabled: true, profile: "minimal", connection: "connected" });

		await service.shutdown();
		expect(transport).toMatchObject({ clearCount: 1, closeCount: 1 });
	});

	it("扩展只在 TUI 启动，并注册可补全的运行时命令", async () => {
		const transport = new FakeTransport();
		const handlers = new Map<string, (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void>();
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		const notices: Array<{ message: string; type: string | undefined }> = [];
		const extensionConfig = enabledConfig();
		extensionConfig.profiles["focus"] = {
			details: { thinking: "Focused" },
			state: "{project}",
			show_elapsed: true,
		};
		const pi = {
			on(name: string, handler: (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void) {
				handlers.set(name, handler);
			},
			registerCommand(_name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
				command = options;
			},
		} as unknown as ExtensionAPI;
		createDiscordPresenceExtension({
			loadConfig: async () => extensionConfig,
			createTransport: async () => transport,
		})(pi);
		const ctx = {
			cwd: "/workspace/o-pi",
			mode: "tui",
			model: { id: "gpt", name: "GPT" },
			isIdle: () => true,
			sessionManager: { getSessionName: () => "Session" },
			ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
		} as ContextStub;

		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("turn_start")?.({ type: "turn_start" }, ctx);
		const streamedCall = { type: "toolCall", id: "edit-1", name: "edit", arguments: {} };
		const assistantMessage = { role: "assistant", timestamp: 1, content: [streamedCall] };
		handlers.get("message_update")?.({
			type: "message_update",
			message: assistantMessage,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistantMessage },
		}, ctx);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Editing" });

		const completedCall = { ...streamedCall, arguments: { path: "/private/a.ts" } };
		const updatedMessage = { ...assistantMessage, content: [completedCall] };
		handlers.get("message_update")?.({
			type: "message_update",
			message: updatedMessage,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"/private/a.ts"',
				partial: updatedMessage,
			},
		}, ctx);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Editing a.ts" });

		handlers.get("tool_execution_start")?.({
			type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "/other/b.ts" },
		}, ctx);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Editing a.ts" });
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "edit-1" }, ctx);
		handlers.get("model_select")?.({ type: "model_select", model: { id: "new", name: "New" } }, ctx);
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Renamed" }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(command?.getArgumentCompletions?.("profile d")).toEqual([{ label: "profile detailed", value: "profile detailed" }]);
		expect(command?.getArgumentCompletions?.("profile f")).toEqual([{ label: "profile focus", value: "profile focus" }]);
		expect(command?.getArgumentCompletions?.("unknown")).toBeNull();
		await command?.handler("profile missing", ctx as never);
		expect(notices.at(-1)).toMatchObject({ type: "error" });
		expect(notices.at(-1)?.message).toContain("Unknown Discord presence profile");
		await command?.handler("profile focus", ctx as never);
		await command?.handler("status", ctx as never);
		await command?.handler("off", ctx as never);
		expect(notices.at(-1)?.message).toContain("Discord presence: off");
		await command?.handler("on", ctx as never);
		await command?.handler("reload", ctx as never);
		await command?.handler("invalid", ctx as never);
		expect(notices.at(-1)).toMatchObject({ type: "error" });
		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

		await handlers.get("session_start")?.({ type: "session_start" }, { ...ctx, mode: "print" });
		await command?.handler("on", { ...ctx, mode: "print" } as never);
		expect(notices.at(-1)).toMatchObject({ type: "error" });
	});
});

describe("@xhayper Discord transport", () => {
	it("连接、设置、清除、断线和关闭均映射为稳定 transport 接口", async () => {
		const transport = await createDiscordRpcTransport("123456789012345678");
		const statuses: string[] = [];
		const unsubscribe = transport.onStatus((status) => statuses.push(status));
		await transport.setActivity({ details: "Thinking", instance: false });
		const client = discordMock.instances[0];
		expect(client?.options).toEqual({ clientId: "123456789012345678", transport: { type: "ipc" } });
		expect(client?.activities).toEqual([{ details: "Thinking", instance: false }]);
		expect(transport.getStatus()).toBe("connected");
		await transport.clearActivity();
		expect(client?.clearCount).toBe(1);

		client?.disconnect();
		expect(transport.getStatus()).toBe("disconnected");
		unsubscribe();
		await transport.close();
		expect(transport.getStatus()).toBe("disabled");
		expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
	});

	it("连接失败后允许使用新 client 重试", async () => {
		discordMock.failNextLogin(new Error("Discord is not running"));
		const transport = await createDiscordRpcTransport("123456789012345678");
		await expect(transport.setActivity({ details: "Initial", instance: false })).rejects.toThrow("not running");
		expect(transport.getStatus()).toBe("disconnected");
		await transport.setActivity({ details: "Recovered", instance: false });
		expect(discordMock.instances).toHaveLength(2);
		await transport.close();
	});

	it("发送失败会丢弃 client，下一次发送重新连接", async () => {
		const transport = await createDiscordRpcTransport("123456789012345678");
		await transport.setActivity({ details: "Initial", instance: false });
		const first = discordMock.instances[0];
		if (first === undefined) throw new Error("mock client missing");
		first.failSet = true;
		await expect(transport.setActivity({ details: "Failure", instance: false })).rejects.toThrow("set failed");
		expect(first.destroyCount).toBe(1);
		await transport.setActivity({ details: "Recovered", instance: false });
		expect(discordMock.instances).toHaveLength(2);
		await transport.close();
	});
});

interface ContextStub {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	model: { id: string; name: string } | undefined;
	isIdle(): boolean;
	sessionManager: { getSessionName(): string | undefined };
	ui: { notify(message: string, type?: string): void };
}
