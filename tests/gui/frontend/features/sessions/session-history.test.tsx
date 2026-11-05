import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Send } from "../../../../../src/gui/frontend/connection/connection.ts";
import { SessionHistory } from "../../../../../src/gui/frontend/features/sessions/session-history.tsx";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

const render = useReactFixture();
beforeEach(() => { vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style); });

it("列表卸载后迟到的打开结果不再关闭后续界面", async () => {
	const result = Promise.withResolvers<void>();
	const close = vi.fn();
	await render(<TooltipProvider><SessionHistory cwd="/project" sessions={[]} sessionsLoading={false} connected canNavigate full
		sessionRows={[{ key: "one", path: "/sessions/one.jsonl", target: { path: "/sessions/one.jsonl" },
			cwd: "/project", title: "目标会话", modified: "", selected: false, activity: undefined }]}
		send={() => result.promise} close={close} refreshSessions={async () => {}} /></TooltipProvider>);
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="目标会话"]');
	if (!button) throw new Error("缺少会话入口");
	await act(async () => button.click());
	await render(null);
	await act(async () => result.resolve());
	expect(close).not.toHaveBeenCalled();
});

it("打开会话失败时保留列表与错误，重试成功后才关闭", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const send = vi.fn<Send>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const close = vi.fn();
	await render(<TooltipProvider><SessionHistory cwd="/project" sessions={[]} sessionsLoading={false} connected canNavigate full
		sessionRows={[{ key: "one", path: "/sessions/one.jsonl", target: { path: "/sessions/one.jsonl" },
			cwd: "/project", title: "目标会话", modified: "", selected: false, activity: undefined }]}
		send={send} close={close} refreshSessions={async () => {}} /></TooltipProvider>);
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="目标会话"]');
	if (!button) throw new Error("缺少会话入口");
	await act(async () => button.click());
	expect(close).not.toHaveBeenCalled();
	expect(button.disabled).toBe(true);
	await act(async () => first.reject(new Error("会话文件无法读取")));
	expect(close).not.toHaveBeenCalled();
	expect(button.disabled).toBe(false);
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("会话文件无法读取");
	await act(async () => button.click());
	expect(close).not.toHaveBeenCalled();
	await act(async () => second.resolve());
	expect(close).toHaveBeenCalledOnce();
	expect(send).toHaveBeenLastCalledWith({ action: "openSession", path: "/sessions/one.jsonl" });
});
