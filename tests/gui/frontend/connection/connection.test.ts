import { afterEach, expect, it, vi } from "vitest";
import type { GuiControl } from "../../../../src/gui/shared/protocol/connection.ts";
import { connectGui } from "../../../../src/gui/frontend/connection/connection.ts";
import { NOTIFICATION_PERMISSION_CHANGED } from "../../../../src/gui/frontend/connection/notifications.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("关注状态通过当前 WebSocket 按序发送，重连重新上报，关闭释放页面监听", async () => {
	vi.useFakeTimers();
	const sockets: Socket[] = [];
	class Socket {
		static OPEN = 1;
		readyState = 0;
		onopen: (() => void) | undefined;
		onclose: (() => void) | undefined;
		readonly sent: GuiControl[] = [];
		constructor() { sockets.push(this); }
		open() { this.readyState = Socket.OPEN; this.onopen?.(); }
		send(data: string) { this.sent.push(JSON.parse(data) as GuiControl); }
		close() { this.readyState = 3; this.onclose?.(); }
	}
	const permission = { permission: "granted" };
	const page = Object.assign(new EventTarget(), { isSecureContext: true, Notification: permission });
	const document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: vi.fn(() => true) });
	vi.stubGlobal("window", page);
	vi.stubGlobal("document", document);
	vi.stubGlobal("Notification", permission);
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal("location", { protocol: "https:", host: "opi.test" });
	vi.stubGlobal("sessionStorage", { getItem: () => null });
	vi.stubGlobal("localStorage", { getItem: () => "browser" });
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const status = vi.fn();
	const connection = connectGui(status);
	const first = sockets[0];
	if (!first) throw new Error("缺少 WebSocket");
	try {
		connection.attend("a");
		expect(first.sent).toEqual([]);
		first.open();
		expect(first.sent).toEqual([{ kind: "attention", value: { sessionId: "a", focused: true, destination: "web:browser" } }]);
		document.hasFocus.mockReturnValue(false);
		page.dispatchEvent(new Event("blur"));
		connection.attend("b");
		document.hasFocus.mockReturnValue(true);
		page.dispatchEvent(new Event("focus"));
		expect(first.sent.slice(1)).toEqual([
			{ kind: "attention", value: { sessionId: "a", focused: false, destination: "web:browser" } },
			{ kind: "attention", value: { sessionId: "b", focused: false, destination: "web:browser" } },
			{ kind: "attention", value: { sessionId: "b", focused: true, destination: "web:browser" } },
		]);
		document.visibilityState = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(first.sent.at(-1)).toMatchObject({ value: { sessionId: "b", focused: false } });
		permission.permission = "denied";
		page.dispatchEvent(new Event(NOTIFICATION_PERMISSION_CHANGED));
		expect(first.sent.at(-1)).toMatchObject({ value: { destination: null } });
		first.close();
		expect(status).toHaveBeenLastCalledWith("disconnected");
		const count = first.sent.length;
		permission.permission = "granted";
		page.dispatchEvent(new Event(NOTIFICATION_PERMISSION_CHANGED));
		connection.attend("c");
		expect(first.sent).toHaveLength(count);
		await vi.advanceTimersByTimeAsync(1000);
		const second = sockets[1];
		if (!second) throw new Error("缺少重连 WebSocket");
		second.open();
		expect(second.sent).toEqual([{ kind: "attention", value: { sessionId: "c", focused: false, destination: "web:browser" } }]);
		connection.close();
		const reads = document.hasFocus.mock.calls.length;
		document.visibilityState = "visible";
		page.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		expect(document.hasFocus).toHaveBeenCalledTimes(reads);
		expect(second.sent).toHaveLength(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally { connection.close(); }
});
