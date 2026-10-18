import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import terminalNotifications from "../../src/tui/notification.ts";
import { APPROVAL_STATUS_CHANNEL } from "../../src/harness/approval/events.ts";
import type { ExtensionHandler } from "../helpers/extension.ts";
import { registerExtension } from "../helpers/extension.ts";
import { preserveEnv } from "../helpers/lifecycle.ts";

const spawn = vi.hoisted(() => vi.fn<(file: string, args: string[], options: { env: NodeJS.ProcessEnv }, callback: () => void) => void>());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: spawn }));
const platform = process.platform;
preserveEnv("OPI_NO_NOTIFICATIONS");
beforeEach(() => { spawn.mockReset(); delete process.env.OPI_NO_NOTIFICATIONS; });
afterEach(() => { Object.defineProperty(process, "platform", { value: platform }); });

function setup(mode = "tui", text = "帮我修复\n 登录问题") {
	const handlers = new Map<string, ExtensionHandler[]>();
	const events = createEventBus();
	registerExtension((pi) => terminalNotifications({ ...pi, on: ((name: string, handler: ExtensionHandler) => {
		const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
	}) as ExtensionAPI["on"] }), { events });
	let input: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
	const removeInput = vi.fn(() => { input = undefined; });
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: text, timestamp: 1 });
	const ctx = { mode, sessionManager: manager, ui: { onTerminalInput(handler: NonNullable<typeof input>) { input = handler; return removeInput; } } };
	const emit = async (name: string, data = {}) => { for (const handler of handlers.get(name) ?? []) await handler(data, ctx); };
	const settle = async (stopReason: "stop" | "aborted" | "error" = "stop") => {
		manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test", timestamp: 2, stopReason,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
		await emit("agent_settled", { aborted: stopReason === "aborted" });
	};
	return { emit, settle, manager, removeInput, input: (data: string) => input?.(data), request: () => events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolName: "bash", toolCallId: "call" }) };
}

it("终端焦点抑制审批和完成，失焦和未知时发送，取消不发送", async () => {
	const tui = setup();
	await tui.emit("session_start");
	tui.request();
	expect(spawn).toHaveBeenCalledOnce();
	expect(spawn.mock.lastCall?.[2].env).toMatchObject({ OPI_NOTIFICATION_TITLE: "OPi 需要审批", OPI_NOTIFICATION_BODY: "帮我修复 登录问题\nbash 请求执行权限" });
	expect(tui.input("\x1b[I")).toEqual({ consume: true });
	tui.request();
	await tui.settle();
	expect(spawn).toHaveBeenCalledOnce();
	expect(tui.input("hello")).toBeUndefined();
	tui.input("\x1b[O");
	await tui.settle("aborted");
	expect(spawn).toHaveBeenCalledOnce();
	tui.manager.appendSessionInfo("检查文件");
	await tui.settle();
	expect(spawn).toHaveBeenCalledTimes(2);
	expect(spawn.mock.lastCall?.[2].env).toMatchObject({ OPI_NOTIFICATION_TITLE: "OPi 任务完成", OPI_NOTIFICATION_BODY: "检查文件" });
	await tui.emit("session_shutdown");
	expect(tui.removeInput).toHaveBeenCalledOnce();
});

it("重载不重复监听，禁用后不发送通知", async () => {
	const tui = setup();
	await tui.emit("session_start");
	await tui.emit("session_start");
	tui.request();
	expect(spawn).toHaveBeenCalledOnce();
	process.env.OPI_NO_NOTIFICATIONS = "1";
	tui.request();
	await tui.settle();
	expect(spawn).toHaveBeenCalledOnce();
	await tui.emit("session_shutdown");
});

it.each(["print", "rpc"])("%s 不启用终端通知", async (mode) => {
	const tui = setup(mode);
	await tui.emit("session_start");
	tui.request(); await tui.settle();
	expect(spawn).not.toHaveBeenCalled();
	await tui.emit("session_shutdown");
});

it("模型失败不发送完成提醒，恢复成功后才发送", async () => {
	const tui = setup();
	await tui.emit("session_start");
	await tui.settle("error");
	expect(spawn).not.toHaveBeenCalled();
	await tui.settle();
	expect(spawn).toHaveBeenCalledOnce();
	await tui.emit("session_shutdown");
});

it("消息含 NUL 被系统命令拒绝时，不阻断审批和完成事件", async () => {
	const tui = setup("tui", "包含\0的消息");
	await tui.emit("session_start");
	spawn.mockImplementation(() => { throw new TypeError("invalid NUL argument"); });
	expect(() => tui.request()).not.toThrow();
	await expect(tui.settle()).resolves.toBeUndefined();
	await tui.emit("session_shutdown");
});

it.each(["linux", "darwin", "win32"] as const)("%s 通知将消息作为数据传递，不执行消息中的脚本", async (platform) => {
	const text = `'; $(touch /tmp/unexpected) <tag> & "`;
	const tui = setup("tui", text);
	Object.defineProperty(process, "platform", { value: platform });
	await tui.emit("session_start");
	await tui.settle();
	expect(spawn).toHaveBeenCalledOnce();
	expect(spawn.mock.lastCall?.[2].env.OPI_NOTIFICATION_BODY).toBe(text);
	const args = spawn.mock.lastCall?.[1];
	if (platform === "linux") {
		expect(args).toContain("--hint=boolean:suppress-sound:true");
		expect(args).toContain("--");
		expect(args?.at(-1)).toBe(`'; $(touch /tmp/unexpected) &lt;tag&gt; &amp; "`);
	} else expect(args?.join(" ")).not.toContain(text);
	await tui.emit("session_shutdown");
});
