import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { EntryActions } from "../../../../../src/gui/frontend/features/sessions/entry-actions.tsx";
import type { Send } from "../../../../../src/gui/frontend/connection/connection.ts";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

const render = useReactFixture();
beforeEach(() => { vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style); });

function button(label: string) {
	const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!button) throw new Error(`缺少按钮 ${label}`);
	return button;
}

it("标签保存只提交一次，失败保留编辑内容，重试成功后退出编辑", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const send = vi.fn<Send>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const message = { role: "user", content: "检查项目", timestamp: 1 } as const;
	await render(<TooltipProvider><EntryActions entry={{ id: "entry", parentId: null, type: "message", timestamp: "", label: "待检查", messages: [message] }} message={message} send={send} /></TooltipProvider>);
	await act(async () => button("编辑标签").click());
	const form = document.querySelector("form");
	if (!form) throw new Error("缺少标签表单");
	await act(async () => {
		form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
		form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	});
	expect(send).toHaveBeenCalledExactlyOnceWith({ action: "label", entryId: "entry", label: "待检查" });
	expect(button("保存标签").disabled).toBe(true);
	await act(async () => first.reject(new Error("保存失败")));
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("保存失败");
	expect(document.querySelector<HTMLInputElement>('input[aria-label="分支标签"]')?.value).toBe("待检查");
	await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
	await act(async () => second.resolve());
	expect(send).toHaveBeenCalledTimes(2);
	expect(document.querySelector("form")).toBeNull();
	expect(button("编辑标签")).toBeTruthy();
});
