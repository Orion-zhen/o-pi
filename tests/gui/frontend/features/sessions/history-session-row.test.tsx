import { act } from "react";
import { expect, it, vi } from "vitest";
import { HistorySessionRow } from "../../../../../src/gui/frontend/features/sessions/history-session-row.tsx";
import type { SessionListItem } from "../../../../../src/gui/frontend/features/sessions/session-list.ts";
import type { Send } from "../../../../../src/gui/frontend/connection/connection.ts";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../../helpers/react-fixture.ts";
import { deferred } from "../../../../helpers/async.ts";

const render = useReactFixture();
const item: SessionListItem = {
	key: "/sessions/one.jsonl", path: "/sessions/one.jsonl", target: { path: "/sessions/one.jsonl" },
	cwd: "/project", title: "原标题", modified: "", selected: false, activity: undefined,
};
const rename = () => {
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="重命名会话 原标题"]');
	if (!button) throw new Error("缺少重命名按钮");
	return button;
};
const openButton = () => {
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="原标题"]');
	if (!button) throw new Error("缺少会话打开按钮");
	return button;
};
async function click(modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
	const event = new window.Event("click", { bubbles: true });
	Object.assign(event, modifiers);
	await act(async () => { rename().dispatchEvent(event); });
}

it("普通点击编辑名称，不请求自动命名", async () => {
	const send = vi.fn<Send>().mockResolvedValue(true);
	const open = vi.fn();
	await render(<TooltipProvider><HistorySessionRow item={item} index={0} count={1} disabled={false} send={send} open={open} animated={false} /></TooltipProvider>);
	await click();
	expect(document.querySelector<HTMLInputElement>('input[aria-label="会话名称"]')?.value).toBe("原标题");
	expect(send).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
});

it.each([{ ctrlKey: true }, { metaKey: true }])("修饰键点击 %j 自动命名且等待期间禁止重复点击", async (modifiers) => {
	const reply = deferred<boolean>();
	const send = vi.fn<Send>().mockReturnValue(reply.promise);
	const open = vi.fn();
	await render(<TooltipProvider><HistorySessionRow item={item} index={0} count={1} disabled={false} send={send} open={open} animated={false} /></TooltipProvider>);
	await click(modifiers);
	expect(send).toHaveBeenCalledExactlyOnceWith({ action: "autoTitleSession", path: item.path });
	expect(rename().disabled).toBe(true);
	expect(openButton().disabled).toBe(true);
	expect(document.querySelector('input[aria-label="会话名称"]')).toBeNull();
	expect(open).not.toHaveBeenCalled();
	await click(modifiers);
	expect(send).toHaveBeenCalledTimes(1);
	await act(async () => reply.resolve(true));
	expect(rename().disabled).toBe(false);
});

it("自动命名等待审批时允许打开会话处理确认", async () => {
	const reply = deferred<boolean>();
	const send = vi.fn<Send>().mockReturnValue(reply.promise);
	const open = vi.fn();
	await render(<TooltipProvider><HistorySessionRow item={item} index={0} count={1} disabled={false} send={send} open={open} animated={false} /></TooltipProvider>);
	await click({ ctrlKey: true });
	expect(openButton().disabled).toBe(true);
	const waiting: SessionListItem = { ...item, activity: {
		sessionId: "one", path: item.path, cwd: item.cwd, title: item.title, modified: item.modified,
		state: "waiting", completedAt: 0, unread: false,
	} };
	await render(<TooltipProvider><HistorySessionRow item={waiting} index={0} count={1} disabled={false} send={send} open={open} animated={false} /></TooltipProvider>);
	expect(openButton().getAttribute("aria-description")).toBe("等待审批");
	expect(openButton().disabled).toBe(false);
	expect(rename().disabled).toBe(true);
	await act(async () => { openButton().click(); });
	expect(open).toHaveBeenCalledExactlyOnceWith(waiting);
	await act(async () => reply.resolve(true));
});
