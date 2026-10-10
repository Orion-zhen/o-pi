import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuiEvent } from "../../src/gui/contract.ts";
import { connectGui } from "../../src/gui/ui/runtime/connection.ts";
import { useConnection } from "../../src/gui/ui/runtime/use-connection.ts";
import { useWindowRefresh } from "../../src/gui/ui/runtime/use-window-refresh.ts";
import { useReactFixture } from "./react-fixture.ts";

vi.mock("../../src/gui/ui/runtime/connection.ts", () => ({ connectGui: vi.fn() }));
const renderRoot = useReactFixture(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function Refresh({ connected, refresh }: { connected: boolean; refresh: () => void }) {
	useWindowRefresh(connected, refresh);
	return null;
}
function Connection({ receive }: { receive: (event: GuiEvent) => void }) {
	useConnection(receive);
	return null;
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("Effect 回调更新", () => {
	it("焦点与可见性事件合并，待执行刷新使用最新回调", async () => {
		const first = vi.fn(), latest = vi.fn();
		await renderRoot(createElement(Refresh, { connected: true, refresh: first }));
		window.dispatchEvent(new window.Event("focus"));
		await vi.advanceTimersByTimeAsync(100);
		document.dispatchEvent(new window.Event("visibilitychange"));
		await renderRoot(createElement(Refresh, { connected: true, refresh: latest }));
		await vi.advanceTimersByTimeAsync(149);
		expect(first).not.toHaveBeenCalled();
		expect(latest).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(latest).toHaveBeenCalledOnce();
	});

	it("断开后取消待执行刷新，后台事件不触发刷新", async () => {
		const refresh = vi.fn();
		await renderRoot(createElement(Refresh, { connected: true, refresh }));
		window.dispatchEvent(new window.Event("focus"));
		await renderRoot(createElement(Refresh, { connected: false, refresh }));
		await vi.advanceTimersByTimeAsync(200);
		expect(refresh).not.toHaveBeenCalled();
		await renderRoot(createElement(Refresh, { connected: true, refresh }));
		Object.defineProperty(document, "visibilityState", { value: "hidden" });
		window.dispatchEvent(new window.Event("focus"));
		await vi.advanceTimersByTimeAsync(200);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("连接订阅保留，事件交给最新回调，卸载释放连接", async () => {
		const listeners = new Set<(event: GuiEvent) => void>();
		const close = vi.fn();
		vi.mocked(connectGui).mockImplementation(() => ({
			send: async () => undefined,
			query: async () => { throw new Error("本测试不发起查询"); },
			subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
			close,
		}));
		const first = vi.fn(), latest = vi.fn();
		await renderRoot(createElement(Connection, { receive: first }));
		await renderRoot(createElement(Connection, { receive: latest }));
		const event: GuiEvent = { type: "sessions", value: [] };
		await act(async () => { for (const listener of listeners) listener(event); });
		expect(connectGui).toHaveBeenCalledOnce();
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledWith(event);
		await renderRoot(null);
		expect(listeners.size).toBe(0);
		expect(close).toHaveBeenCalledOnce();
	});
});
