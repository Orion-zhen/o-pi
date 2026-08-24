import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordPresenceExtension } from "../../agent/extensions/discord-presence.js";
import { DiscordPresenceCoordinatorClient } from "../../src/discord-presence/coordinator-client.js";
import { DiscordPresenceService } from "../../src/discord-presence/service.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { enabledConfig, FakeCoordinator } from "./fixtures.js";

const temp = useTempDir("o-pi-discord-presence-service-");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Discord presence 服务与 Pi 适配", () => {
	it("配置尚未加载时不虚构 profile", () => {
		const service = new DiscordPresenceService({ coordinator: new FakeCoordinator() });

		expect(service.status()).toEqual({ enabled: false, profile: undefined, connection: "disabled" });
		expect(service.profileNames()).toEqual([]);
	});

	it("初始化错误交给 Pi 扩展边界处理", async () => {
		const handlers = new Map<string, (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void>();
		const pi = {
			on(name: string, handler: (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void) {
				handlers.set(name, handler);
			},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		createDiscordPresenceExtension({
			loadConfig: async () => { throw new Error("invalid presence config"); },
			coordinator: new FakeCoordinator(),
		})(pi);
		const start = handlers.get("session_start");
		if (start === undefined) throw new Error("session_start handler missing");

		await expect(start({ type: "session_start" }, {
			cwd: "/workspace/o-pi",
			mode: "tui",
			model: undefined,
			isIdle: () => true,
			sessionManager: { getSessionName: () => undefined },
			ui: { notify: () => undefined },
		})).rejects.toThrow("invalid presence config");
	});

	it.skipIf(process.platform === "win32")("本地协调端点准备失败时回滚为关闭状态", async () => {
		const blockedDirectory = path.join(temp.path, "blocked-endpoint");
		await writeFile(blockedDirectory, "not a directory");
		const coordinator = new DiscordPresenceCoordinatorClient({
			endpoint: path.join(blockedDirectory, "coordinator.sock"),
			spawnDaemon: () => undefined,
		});
		const service = new DiscordPresenceService({
			loadConfig: async () => enabledConfig(), coordinator, processStartedAt: Date.now(),
		});
		await expect(service.startSession({
			cwd: "/workspace/o-pi", model: undefined, sessionName: undefined, idle: true,
		})).rejects.toThrow();
		expect(service.status()).toMatchObject({ enabled: false, connection: "disabled" });
	});

	it("reload 与 off/on 始终沿用 Pi 进程计时起点", async () => {
		const coordinator = new FakeCoordinator();
		const processStartedAt = Date.now();
		const service = new DiscordPresenceService({
			loadConfig: async () => enabledConfig(), coordinator, processStartedAt,
		});
		const context = {
			cwd: "/workspace/o-pi", model: { id: "gpt", name: "GPT" }, sessionName: "Session", idle: true,
		};
		await service.startSession(context);
		vi.setSystemTime(new Date("2026-08-21T11:00:00Z"));
		await service.reload(context);
		expect(coordinator.activations).toHaveLength(2);
		expect(coordinator.activations[1]).toMatchObject({
			joinedAt: processStartedAt,
			activity: { details: "Waiting in o-pi", startTimestamp: processStartedAt },
		});
		expect(coordinator.deactivateCount).toBe(0);

		await service.disable();
		expect(coordinator.deactivateCount).toBe(1);
		vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
		await service.enable(context);
		expect(coordinator.activations[2]).toMatchObject({
			joinedAt: processStartedAt,
			activity: { startTimestamp: processStartedAt },
		});
	});

	it.each(["new", "resume", "fork", "reload"] as const)(
		"扩展运行时因 %s 重建后仍沿用当前 Pi 进程的计时起点",
		async (reason) => {
			const coordinator = new FakeCoordinator();
			const context = {
				cwd: "/workspace/o-pi",
				mode: "tui",
				model: { id: "gpt", name: "GPT" },
				isIdle: () => true,
				sessionManager: { getSessionName: () => "Session" },
				ui: { notify: () => undefined },
			} as ContextStub;
			const registerRuntime = () => {
				const handlers = new Map<string, (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void>();
				const pi = {
					on(name: string, handler: (event: Record<string, unknown>, ctx: ContextStub) => Promise<void> | void) {
						handlers.set(name, handler);
					},
					registerCommand() {},
				} as unknown as ExtensionAPI;
				createDiscordPresenceExtension({ loadConfig: async () => enabledConfig(), coordinator })(pi);
				return handlers;
			};

			const firstRuntime = registerRuntime();
			await firstRuntime.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
			const processStartedAt = coordinator.activations[0]?.joinedAt;
			expect(processStartedAt).toBeTypeOf("number");
			await firstRuntime.get("session_shutdown")?.({ type: "session_shutdown", reason }, context);

			vi.setSystemTime(new Date("2026-08-21T11:00:00Z"));
			const replacementRuntime = registerRuntime();
			await replacementRuntime.get("session_start")?.({ type: "session_start", reason }, context);
			expect(coordinator.activations[1]).toMatchObject({
				joinedAt: processStartedAt,
				activity: { startTimestamp: processStartedAt },
			});
			await replacementRuntime.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
		},
	);

	it("合并快速事件、切换 profile，并在 settled 与 shutdown 时更新和清理", async () => {
		const coordinator = new FakeCoordinator();
		const service = new DiscordPresenceService({
			loadConfig: async () => enabledConfig(),
			coordinator,
			processStartedAt: Date.now(),
		});
		await service.startSession({
			cwd: "/workspace/o-pi",
			model: { id: "gpt", name: "GPT" },
			sessionName: "Rich Presence",
			idle: true,
		});
		expect(coordinator.activities).toHaveLength(1);
		expect(coordinator.activities[0]).toMatchObject({ details: "Waiting in o-pi" });

		service.onTurnStart();
		service.onToolStart("read", "read", { path: "/secret/file.ts" });
		service.onToolStart("bash", "bash", { command: "git status --private" });
		service.onToolEnd("bash");
		service.onModelSelect({ id: "new", name: "New Model" });
		service.onSessionName("Renamed");
		expect(coordinator.activities.at(-1)).toMatchObject({ details: "Reading file.ts", state: "o-pi · New Model" });

		const sentBeforeMinimal = coordinator.activities.length;
		service.selectProfile("minimal");
		service.onToolStart("bash-minimal", "bash", { command: "npm test" });
		service.onToolEnd("bash-minimal");
		expect(coordinator.activities).toHaveLength(sentBeforeMinimal);
		service.onAgentSettled();
		expect(coordinator.activities.at(-1)).toMatchObject({ details: "Waiting for input", state: "Pi Coding Agent" });
		expect(coordinator.activities.at(-1)).not.toHaveProperty("startTimestamp");
		expect(service.status()).toMatchObject({ enabled: true, profile: "minimal", connection: "connected" });

		await service.shutdown();
		expect(coordinator.deactivateCount).toBe(1);
	});

	it("扩展只在 TUI 启动，并注册可补全的运行时命令", async () => {
		const coordinator = new FakeCoordinator();
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
			coordinator,
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
		expect(coordinator.activities.at(-1)).toMatchObject({ details: "Editing" });

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
		expect(coordinator.activities.at(-1)).toMatchObject({ details: "Editing a.ts" });

		handlers.get("tool_execution_start")?.({
			type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "/other/b.ts" },
		}, ctx);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(coordinator.activities.at(-1)).toMatchObject({ details: "Editing a.ts" });
		handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "edit-1" }, ctx);
		handlers.get("model_select")?.({ type: "model_select", model: { id: "new", name: "New" } }, ctx);
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "Renamed" }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(command?.getArgumentCompletions?.("profile d")).toEqual([{ label: "profile detailed", value: "profile detailed" }]);
		expect(command?.getArgumentCompletions?.("profile f")).toEqual([{ label: "profile focus", value: "profile focus" }]);
		expect(command?.getArgumentCompletions?.("unknown")).toBeNull();
		await expect(command?.handler("profile missing", ctx as never)).rejects.toThrow("Unknown Discord presence profile");
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


interface ContextStub {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	model: { id: string; name: string } | undefined;
	isIdle(): boolean;
	sessionManager: { getSessionName(): string | undefined };
	ui: { notify(message: string, type?: string): void };
}
