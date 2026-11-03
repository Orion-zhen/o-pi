import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { useAttachments } from "../../../../../../src/gui/frontend/features/chat/composer/use-attachments.ts";
import { SessionViews, type SessionViewState } from "../../../../../../src/gui/frontend/features/sessions/session-views.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";

const renderRoot = useReactFixture();

function delayedFile(name: string) {
	const gate = Promise.withResolvers<ArrayBuffer>();
	const file = new File([], name);
	vi.spyOn(file, "arrayBuffer").mockImplementation(() => gate.promise);
	return { file, finish: (text: string) => gate.resolve(new TextEncoder().encode(text).buffer) };
}

async function setup() {
	const views = new SessionViews();
	const original = views.open({ id: "a", path: null });
	const setError = vi.fn();
	let upload: ReturnType<typeof useAttachments> | undefined;
	function Harness({ view }: { view: SessionViewState }) {
		upload = useAttachments(view, views, setError);
		return null;
	}
	const render = (view: SessionViewState) => renderRoot(createElement(Harness, { key: view.id, view }));
	await render(original);
	if (!upload) throw new Error("缺少附件处理器");
	return { views, original, upload, setError, render, pending: () => upload?.pending };
}

it("并发读取附件合并最新草稿，不覆盖读取期间的编辑", async () => {
	const { views, original, upload, setError, pending } = await setup();
	const first = delayedFile("first.txt");
	const second = delayedFile("second.txt");
	let tasks: Promise<void>[] = [];
	await act(async () => { tasks = [upload.attach([first.file]), upload.attach([second.file])]; });
	expect(pending()).toBe(true);
	await act(async () => views.writeText(original.id, "读取期间编辑"));
	await act(async () => { second.finish("second"); await tasks[1]; });
	expect(pending()).toBe(true);
	await act(async () => { first.finish("first"); await tasks[0]; });
	expect(pending()).toBe(false);
	expect(original.draft.text).toBe('读取期间编辑\n\n<file path="second.txt">\nsecond\n</file>\n\n<file path="first.txt">\nfirst\n</file>');
	expect(setError).not.toHaveBeenCalled();
});

it("一批附件失败不会提前结束另一批附件的等待状态", async () => {
	const { original, upload, setError, pending } = await setup();
	const delayed = delayedFile("pending.txt");
	let task = Promise.resolve();
	await act(async () => { task = upload.attach([delayed.file]); });
	await act(async () => upload.attach([new File([new Uint8Array([0])], "binary.bin")]));
	expect(setError).toHaveBeenCalledWith("二进制附件请通过 @路径 引用后端文件。");
	expect(pending()).toBe(true);
	expect(original.draft.text).toBe("");
	await act(async () => { delayed.finish("成功附件"); await task; });
	expect(pending()).toBe(false);
	expect(original.draft.text).toContain("成功附件");
});

it("切换会话取消所有未完成的附件，不污染任何会话或显示取消错误", async () => {
	const { views, original, upload, setError, render, pending } = await setup();
	const first = delayedFile("first.txt");
	const second = delayedFile("second.txt");
	let tasks: Promise<void>[] = [];
	await act(async () => { tasks = [upload.attach([first.file]), upload.attach([second.file])]; });
	const next = views.open({ id: "b", path: null });
	await render(next);
	expect(pending()).toBe(false);
	await act(async () => { first.finish("不应写入"); second.finish("也不应写入"); await Promise.all(tasks); });
	// 模拟桌面拖入分类的 IPC 在切换会话后返回附件。
	const late = new File(["迟到附件"], "late.txt");
	const read = vi.spyOn(late, "arrayBuffer");
	await act(async () => upload.attach([late]));
	expect(read).not.toHaveBeenCalled();
	expect(original.draft.text).toBe("");
	expect(next.draft.text).toBe("");
	expect(setError).not.toHaveBeenCalled();
});
