import { act, createElement, createRef, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../../../../../src/gui/frontend/features/chat/composer/composer.tsx";
import { TooltipProvider } from "../../../../../../src/gui/frontend/ui/tooltip.tsx";
import { SessionViews } from "../../../../../../src/gui/frontend/features/sessions/session-views.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";
import { guiModelFixture, guiSnapshot } from "../../../../helpers/snapshot-fixture.ts";
import type { DesktopDrop } from "../../../../../../src/gui/shared/protocol/desktop.ts";

function ready(snapshot: ReturnType<typeof guiSnapshot>, view: ReturnType<SessionViews["open"]>, send: ComponentProps<typeof Composer>["session"]["send"]): ComponentProps<typeof Composer>["session"] {
	return { state: "ready", target: { id: snapshot.sessionId, cwd: snapshot.cwd, path: null }, view, snapshot, send,
		dialogs: [], notices: [], stats: undefined, telemetry: undefined,
		query: async () => { throw new Error("本测试不查询数据"); } };
}

const renderRoot = useReactFixture(() => { Reflect.deleteProperty(window, "opi"); });
beforeEach(() => { vi.stubGlobal("HTMLFormElement", window.HTMLFormElement); });

describe("文件拖入", () => {
	async function dropFiles(files: File[]) {
		const card = document.querySelector(".composer-card");
		if (!card) throw new Error("缺少拖入区域");
		const event = new window.Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
		await act(async () => { card.dispatchEvent(event); });
		expect(event.defaultPrevented).toBe(true);
	}

	async function drop(files: File[], items?: DesktopDrop[]) {
		const model = guiModelFixture();
		const snapshot = { ...guiSnapshot(), model, models: [model] };
		const views = new SessionViews();
		const view = views.open({ id: snapshot.sessionId, path: null });
		views.writeText(view.id, "草稿");
		const send = vi.fn(async () => {});
		const prepareDrop = vi.fn(async () => items);
		if (items) Object.defineProperty(window, "opi", { configurable: true, value: { prepareDrop } });
		const gui: ComponentProps<typeof Composer>["gui"] = {
			connected: true, canSubmit: true, workspaceMissing: false, views, editor: createRef<HTMLTextAreaElement>(), setPanel() {},
		};
		await renderRoot(createElement(TooltipProvider, null,
			createElement(Composer, { ref: null, style: {}, gui, session: ready(snapshot, view, send), preferences: undefined, onSubmit() {} })));
		await dropFiles(files);
		expect(document.querySelector('[role="alert"]')).toBeNull();
		if (items) expect(prepareDrop).toHaveBeenCalledExactlyOnceWith(snapshot.cwd, files);
		return { view, views, send };
	}

	it("混合拖入文件和目录时，文件保留为附件，目录插入引用，不自动发送", async () => {
		const { view, send } = await drop([
			new File(["工作区文件"], "你好 world.txt"), new File(["外部内容"], "outside.txt"),
			new File(["不应读入"], "folder"),
		], [
			{ kind: "attachment" }, { kind: "attachment" },
			{ kind: "reference", path: "folder" },
		]);
		expect(view.draft.text).toBe("草稿 @folder ");
		expect(view.draft.files).toMatchObject([{ name: "你好 world.txt", text: "工作区文件" }, { name: "outside.txt", text: "外部内容" }]);
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
		expect(view.draft.text).toBe("草稿");
		expect(view.draft.files).toMatchObject([{ name: "file.txt", text: "文件内容", size: 12 }]);
		expect(document.querySelector('button[aria-label="预览附件 file.txt"]')?.textContent).toContain("12 B");
		expect(document.body.textContent).not.toContain("文件内容");
		expect(send).not.toHaveBeenCalled();
	});
	it("文本附件可移除和单独发送，发送失败后仍以附件恢复", async () => {
		const content = "@missing.txt\n# 标题\n$x$\n<script>内容</script>";
		const { view, views, send } = await drop([new File(["移除"], "remove.txt"), new File([content], "notes.md")]);
		const remove = document.querySelector<HTMLButtonElement>('button[aria-label="移除附件 remove.txt"]');
		if (!remove) throw new Error("缺少移除按钮");
		await act(async () => { remove.click(); views.writeText(view.id, ""); });
		expect(view.draft.files).toHaveLength(1);
		const submit = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]');
		if (!submit) throw new Error("缺少发送按钮");
		expect(submit.disabled).toBe(false);
		send.mockRejectedValueOnce(new Error("发送失败"));
		await act(async () => submit.click());
		expect(send).toHaveBeenCalledExactlyOnceWith({ action: "prompt", text: "", images: [], files: [{ name: "notes.md", text: content }], behavior: "steer" });
		expect(view.draft.text).toBe("");
		expect(view.draft.files).toMatchObject([{ name: "notes.md", text: content }]);
		await act(async () => submit.click());
		expect(view.draft.files).toEqual([]);
	});
	it("发送期间继续编辑并拖入附件，失败后保留新输入并恢复旧附件", async () => {
		const { view, views, send } = await drop([new File(["旧附件"], "old.txt")]);
		const failure = Promise.withResolvers<void>();
		send.mockReturnValueOnce(failure.promise);
		const submit = document.querySelector<HTMLButtonElement>('button[aria-label="发送"]');
		if (!submit) throw new Error("缺少发送按钮");
		await act(async () => submit.click());
		expect(view.draft.files).toEqual([]);
		await act(async () => views.writeText(view.id, "新输入"));
		await dropFiles([new File(["新附件"], "new.txt")]);
		await act(async () => { failure.reject(new Error("发送失败")); });
		expect(view.draft.text).toBe("新输入");
		expect(view.draft.files).toMatchObject([{ name: "old.txt", text: "旧附件" }, { name: "new.txt", text: "新附件" }]);
	});
});

describe("输入框停止优先级", () => {
	it.each(["", "保留这份草稿"])("压缩期间停止优先，草稿为 %j", async (draft) => {
		const snapshot = { ...guiSnapshot(), running: true, canChangeSession: false, compacting: true };
		const views = new SessionViews();
		const view = views.open({ id: snapshot.sessionId, path: null });
		const send = vi.fn(async () => {});
		const gui: ComponentProps<typeof Composer>["gui"] = {
			connected: true, canSubmit: true, workspaceMissing: false, views,
			editor: createRef<HTMLTextAreaElement>(), setPanel() {},
		};
		const onSubmit = vi.fn();
		const render = () => renderRoot(createElement(TooltipProvider, null,
			createElement(Composer, { ref: null, style: {}, gui, session: ready(snapshot, view, send), preferences: undefined, onSubmit })));
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
