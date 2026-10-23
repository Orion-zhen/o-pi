import { act, createElement, useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSessionActivity } from "../../src/gui/frontend/features/sessions/use-session-activity.ts";
import { useReactFixture } from "./react-fixture.ts";

const renderRoot = useReactFixture(() => { Reflect.deleteProperty(window, "opi"); vi.resetAllMocks(); });
const report = vi.fn();
const markRead = vi.fn();
const storage = { getItem: vi.fn<() => string | null>(), setItem: vi.fn() };
beforeEach(() => {
	vi.stubGlobal("sessionStorage", storage);
	Object.defineProperty(window, "opi", { configurable: true, value: { markRead } });
	storage.getItem.mockReturnValue(null);
});

function Activity({ completedAt }: { completedAt: number }) {
	const state = useSessionActivity([
		{ sessionId: "task", cwd: "/work", path: null, title: "任务", state: "idle", modified: "", completedAt },
	], report);
	useEffect(() => {
		const read = () => state.markRead("task", completedAt);
		window.addEventListener("focus", read);
		return () => window.removeEventListener("focus", read);
	}, [state.markRead, completedAt]);
	return createElement("div", null,
		createElement("output", null, state.activity[0]?.unread ? "未读" : "已读"),
		createElement("button", { onClick: () => state.forget(["task"]) }, "删除记录"),
	);
}
const render = (completedAt: number) => renderRoot(createElement(Activity, { completedAt }));
const focus = () => act(async () => { window.dispatchEvent(new window.Event("focus")); });

it("回到会话阅读结果后清除未读，重复聚焦不写入，新结果再次标为未读", async () => {
	await render(100);
	expect(document.querySelector("output")?.textContent).toBe("未读");
	await focus();
	await focus();
	expect(document.querySelector("output")?.textContent).toBe("已读");
	expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("opi.read", '{"task":100}');
	expect(markRead).toHaveBeenCalledExactlyOnceWith("task", 100);
	await render(200);
	expect(document.querySelector("output")?.textContent).toBe("未读");
	await focus();
	expect(storage.setItem).toHaveBeenCalledTimes(2);
	expect(storage.setItem).toHaveBeenLastCalledWith("opi.read", '{"task":200}');
	expect(markRead).toHaveBeenLastCalledWith("task", 200);
});

it("恢复已有记录后无需重复阅读，删除会话只清除对应记录", async () => {
	storage.getItem.mockReturnValue('{"task":100,"other":50}');
	await render(100);
	expect(document.querySelector("output")?.textContent).toBe("已读");
	await focus();
	expect(storage.setItem).not.toHaveBeenCalled();
	expect(markRead).not.toHaveBeenCalled();
	const button = document.querySelector("button");
	if (!button) throw new Error("缺少删除入口");
	await act(async () => button.click());
	expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("opi.read", '{"other":50}');
});

it("存储失败仍更新本地与原生已读状态，并报告错误", async () => {
	storage.setItem.mockImplementation(() => { throw new Error("storage full"); });
	await render(100);
	await focus();
	expect(document.querySelector("output")?.textContent).toBe("已读");
	expect(markRead).toHaveBeenCalledExactlyOnceWith("task", 100);
	expect(report).toHaveBeenCalledExactlyOnceWith("已读记录保存失败: Error: storage full");
});

it("Web 无桌面桥接时仍可阅读结果，尚无结果时不写入记录", async () => {
	Reflect.deleteProperty(window, "opi");
	await render(0);
	await focus();
	expect(storage.setItem).not.toHaveBeenCalled();
	await render(100);
	await focus();
	expect(document.querySelector("output")?.textContent).toBe("已读");
	expect(storage.setItem).toHaveBeenCalledExactlyOnceWith("opi.read", '{"task":100}');
	expect(markRead).not.toHaveBeenCalled();
});
