import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Attention } from "../../src/harness/attention.ts";
import type { GuiControl } from "../../src/gui/contract.ts";
import { GuiChannel } from "../../src/gui/host/channel.ts";
import { connectGui } from "../../src/gui/ui/runtime/connection.ts";
import { notificationDestination, showBrowserNotification } from "../../src/gui/ui/runtime/browser-notifications.ts";

const electron = vi.hoisted(() => ({ shown: vi.fn(), instances: [] as EventEmitter[] }));
vi.mock("electron", () => ({ BrowserWindow: class extends EventEmitter {
	isFocused() { return true; }
	isVisible() { return true; }
	isMinimized() { return false; }
}, Notification: class extends EventEmitter {
	static isSupported() { return true; }
	constructor(readonly options: unknown) { super(); electron.instances.push(this); }
	show() { electron.shown(this.options); }
} }));
import { showDesktopNotification, trackDesktopAttention } from "../../src/desktop/notifications.ts";
import { BrowserWindow } from "electron";

const value: Attention = { kind: "completed", sessionId: "background", name: undefined, firstMessage: "检查后台任务" };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); electron.instances.length = 0; electron.shown.mockReset(); });

it("Web 后台页面暂停绘制、发送窗口已满时，通知仍立即到达", async () => {
	let receive: ((event: { data: string }) => void) | undefined;
	let draw: FrameRequestCallback | undefined;
	const channel = new GuiChannel((delivery) => receive?.({ data: JSON.stringify(delivery) }));
	const send = vi.fn((data: string) => {
		const control = JSON.parse(data) as GuiControl;
		if (control.kind === "ack") channel.acknowledge(control.id);
	});
	vi.stubGlobal("WebSocket", class {
		static OPEN = 1;
		readyState = 1;
		set onmessage(listener: NonNullable<typeof receive>) { receive = listener; }
		send = send;
		close() {}
	});
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("document", new EventTarget());
	vi.stubGlobal("location", { protocol: "https:", host: "opi.test" });
	vi.stubGlobal("sessionStorage", { getItem: () => null });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { draw = callback; return 1; });
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	const connection = connectGui(() => {});
	const listener = vi.fn();
	connection.subscribe(listener);
	try {
		for (let i = 0; i < 6; i++) { channel.accept({ type: "activity", value: [] }); await Promise.resolve(); }
		channel.accept({ type: "notification", value });
		expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "notification", value });
		expect(send).not.toHaveBeenCalled();
		draw?.(0);
		expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ kind: "ack", id: 4 }));
		await Promise.resolve();
		draw?.(1);
		expect(send).toHaveBeenLastCalledWith(JSON.stringify({ kind: "ack", id: 5 }));
	} finally { connection.close(); channel.close(); }
});

it("浏览器授权后显示首条消息摘要，点击定位会话，撤销权限后停止发送", () => {
	const shown = vi.fn();
	const close = vi.fn();
	let click: (() => void) | undefined;
	class BrowserNotification {
		static permission = "granted";
		constructor(title: string, options: NotificationOptions) { shown(title, options); }
		close = close;
		set onclick(value: () => void) { click = value; }
	}
	const focus = vi.fn();
	vi.stubGlobal("Notification", BrowserNotification);
	vi.stubGlobal("window", { isSecureContext: true, Notification: BrowserNotification, focus });
	vi.stubGlobal("localStorage", { getItem: () => "browser-id" });
	const open = vi.fn();
	expect(notificationDestination()).toBe("web:browser-id");
	showBrowserNotification({ ...value, firstMessage: "首条\n 消息" }, open);
	expect(shown).toHaveBeenCalledWith("OPi 任务完成", expect.objectContaining({ body: "首条 消息", silent: true }));
	click?.();
	expect(open).toHaveBeenCalledOnce();
	expect(focus).toHaveBeenCalledOnce();
	expect(close).toHaveBeenCalledOnce();
	BrowserNotification.permission = "denied";
	expect(notificationDestination()).toBeNull();
	showBrowserNotification(value, open);
	expect(shown).toHaveBeenCalledOnce();
});

it("Desktop 关注状态随原生窗口焦点、最小化和隐藏更新", () => {
	const window = new BrowserWindow();
	const focused = vi.spyOn(window, "isFocused");
	const visible = vi.spyOn(window, "isVisible");
	const minimized = vi.spyOn(window, "isMinimized");
	const report = vi.fn();
	const attend = trackDesktopAttention(window, report);
	attend("a");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "a", focused: true, destination: "desktop" });
	focused.mockReturnValue(false);
	window.emit("blur");
	attend("b");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "b", focused: false, destination: "desktop" });
	focused.mockReturnValue(true);
	window.emit("focus");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "b", focused: true, destination: "desktop" });
	minimized.mockReturnValue(true);
	window.emit("minimize");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "b", focused: false, destination: "desktop" });
	minimized.mockReturnValue(false);
	window.emit("restore");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "b", focused: true, destination: "desktop" });
	visible.mockReturnValue(false);
	window.emit("hide");
	expect(report).toHaveBeenLastCalledWith({ sessionId: "b", focused: false, destination: "desktop" });
});

it("Electron 审批通知使用会话名，点击定位会话，系统拒绝不影响后续通知", () => {
	const open = vi.fn();
	showDesktopNotification({ ...value, name: "检查文件", kind: "approval", toolName: "bash" }, "icon.png", open);
	expect(electron.shown).toHaveBeenCalledWith({ title: "OPi 需要审批", body: "检查文件\nbash 请求执行权限", silent: false, icon: "icon.png" });
	electron.instances[0]?.emit("click");
	expect(open).toHaveBeenCalledOnce();
	electron.shown.mockImplementationOnce(() => { throw new Error("backend unavailable"); });
	expect(() => showDesktopNotification(value, "icon.png", open)).not.toThrow();
	showDesktopNotification(value, "icon.png", open);
	expect(electron.shown).toHaveBeenLastCalledWith({ title: "OPi 任务完成", body: "检查后台任务", silent: true, icon: "icon.png" });
	electron.instances[2]?.emit("close");
});
