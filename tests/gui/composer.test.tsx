import { act, createElement, createRef, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/gui/frontend/features/chat/composer/composer.tsx";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { SessionViews } from "../../src/gui/frontend/features/sessions/session-views.ts";
import { useReactFixture } from "./react-fixture.ts";
import { guiSnapshot } from "./snapshot-fixture.ts";

const renderRoot = useReactFixture();
beforeEach(() => { vi.stubGlobal("HTMLFormElement", window.HTMLFormElement); });

describe("输入框停止优先级", () => {
	it.each(["", "保留这份草稿"])("压缩期间停止优先，草稿为 %j", async (draft) => {
		const snapshot = { ...guiSnapshot(), running: true, canChangeSession: false, compacting: true };
		const views = new SessionViews();
		const view = views.open({ id: snapshot.sessionId, path: null });
		const send = vi.fn(async () => true);
		const gui: ComponentProps<typeof Composer>["gui"] = {
			connected: true, canSubmit: true, canChangeSession: false, views,
			editor: createRef<HTMLTextAreaElement>(), send, setError() {}, setPanel() {},
			query: async () => { throw new Error("本测试不查询数据"); },
		};
		const onSubmit = vi.fn();
		const render = () => renderRoot(createElement(TooltipProvider, null,
			createElement(Composer, { gui, view, snapshot, preferences: undefined, onSubmit })));
		await render();
		await act(async () => views.writeText(view.id, draft));
		const stop = document.querySelector<HTMLButtonElement>('button[aria-label="停止压缩"]');
		if (!stop) throw new Error("缺少停止压缩按钮");
		expect(stop.disabled).toBe(false);
		await act(async () => stop.click());
		expect(send).toHaveBeenCalledWith({ action: "abort" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(view.draft.text).toBe(draft);
		expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')?.value).toBe(draft);
		snapshot.compacting = false;
		snapshot.running = false;
		await render();
		const submit = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]');
		expect(submit).not.toBeNull();
		expect(submit?.disabled).toBe(!draft);
		expect(view.draft.text).toBe(draft);
		snapshot.running = true;
		await render();
		expect(document.querySelector(`button[aria-label="${draft ? "发送" : "停止"}"]`)).not.toBeNull();
	});
});
