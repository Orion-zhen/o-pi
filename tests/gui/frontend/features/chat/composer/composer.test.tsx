import { act, createElement, createRef, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../../../../../src/gui/frontend/features/chat/composer/composer.tsx";
import { TooltipProvider } from "../../../../../../src/gui/frontend/ui/tooltip.tsx";
import { SessionViews } from "../../../../../../src/gui/frontend/features/sessions/session-views.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";
import { guiSnapshot } from "../../../../helpers/snapshot-fixture.ts";
import type { DesktopDrop } from "../../../../../../src/gui/shared/protocol/desktop.ts";

const renderRoot = useReactFixture(() => { Reflect.deleteProperty(window, "opi"); });
beforeEach(() => { vi.stubGlobal("HTMLFormElement", window.HTMLFormElement); });

describe("文件拖入", () => {
	async function drop(files: File[], items?: DesktopDrop[]) {
		const snapshot = guiSnapshot();
		const views = new SessionViews();
		const view = views.open({ id: snapshot.sessionId, path: null });
		views.writeText(view.id, "草稿");
		const send = vi.fn(async () => true);
		const setError = vi.fn();
		const prepareDrop = vi.fn(async () => items);
		if (items) Object.defineProperty(window, "opi", { configurable: true, value: { prepareDrop } });
		const gui: ComponentProps<typeof Composer>["gui"] = {
			connected: true, canSubmit: true, views, editor: createRef<HTMLTextAreaElement>(), send, setError, setPanel() {},
			query: async () => { throw new Error("本测试不查询数据"); },
		};
		await renderRoot(createElement(TooltipProvider, null,
			createElement(Composer, { gui, view, snapshot, preferences: undefined, onSubmit() {} })));
		const card = document.querySelector(".composer-card");
		if (!card) throw new Error("缺少拖入区域");
		const event = new window.Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
		await act(async () => { card.dispatchEvent(event); });
		expect(event.defaultPrevented).toBe(true);
		expect(setError).not.toHaveBeenCalled();
		if (items) expect(prepareDrop).toHaveBeenCalledExactlyOnceWith(snapshot.cwd, files);
		return { view, send };
	}

	it("混合拖入引用和附件时保留原文件对应关系，不自动发送", async () => {
		const { view, send } = await drop([
			new File(["不应读入"], "你好 world.txt"), new File(["外部内容"], "outside.txt"),
			new File(["不应读入"], "folder"),
		], [
			{ kind: "reference", path: "你好 world.txt" }, { kind: "attachment" },
			{ kind: "reference", path: "folder" },
		]);
		expect(view.draft.text).toBe('草稿 @"你好 world.txt" @folder \n\n<file path="outside.txt">\n外部内容\n</file>');
		expect(send).not.toHaveBeenCalled();
	});
	it("取消外部目录操作不修改草稿，也不将目录作为附件读取", async () => {
		const { view, send } = await drop([new File(["目录不应读入"], "outside")], []);
		expect(view.draft.text).toBe("草稿");
		expect(send).not.toHaveBeenCalled();
	});
	it("选择打开外部目录时只切换工作区", async () => {
		const { view, send } = await drop([new File([], "outside")], [{ kind: "workspace", path: "/outside" }]);
		expect(view.draft.text).toBe("草稿");
		expect(send).toHaveBeenCalledExactlyOnceWith({ action: "workspace", path: "/outside" });
	});
	it("Web 没有桌面桥接时仍按附件处理", async () => {
		const { view, send } = await drop([new File(["文件内容"], "file.txt")]);
		expect(view.draft.text).toBe('草稿\n\n<file path="file.txt">\n文件内容\n</file>');
		expect(send).not.toHaveBeenCalled();
	});
});

describe("输入框停止优先级", () => {
	it.each(["", "保留这份草稿"])("压缩期间停止优先，草稿为 %j", async (draft) => {
		const snapshot = { ...guiSnapshot(), running: true, canChangeSession: false, compacting: true };
		const views = new SessionViews();
		const view = views.open({ id: snapshot.sessionId, path: null });
		const send = vi.fn(async () => true);
		const gui: ComponentProps<typeof Composer>["gui"] = {
			connected: true, canSubmit: true, views,
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
