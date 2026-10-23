import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityState } from "../../src/gui/ui/tools/tool-display.tsx";
import { ConfirmAction } from "../../src/gui/ui/components/confirm-action.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();

function icon() {
	const svg = document.querySelector("svg");
	if (!svg) throw new Error("缺少状态图标");
	return svg;
}

describe("图标状态过渡", () => {
	it.each([
		["completed", "完成"], ["failed", "执行失败"], ["stopped", "已停止"],
	] as const)("工具从等待、运行到 %s 更新状态并停止旋转", async (state, label) => {
		await render(createElement(ActivityState, { state: "pending" }));
		expect(document.body.textContent).toBe("等待执行");
		const svg = icon();
		await render(createElement(ActivityState, { state: "running" }));
		expect(document.body.textContent).toBe("执行中");
		expect(icon()).toBe(svg);
		expect(svg.classList.contains("animate-spin")).toBe(true);
		await render(createElement(ActivityState, { state }));
		expect(document.body.textContent).toBe(label);
		expect(icon()).toBe(svg);
		expect(svg.classList.contains("animate-spin")).toBe(false);
	});

	it("删除确认的图标变形不延迟第二次点击", async () => {
		const confirm = vi.fn(async () => {});
		await render(createElement(TooltipProvider, null, createElement(ConfirmAction, { label: "删除会话", disabled: false, confirm })));
		const button = document.querySelector("button");
		if (!button) throw new Error("缺少删除按钮");
		const svg = icon();
		await act(async () => button.click());
		expect(confirm).not.toHaveBeenCalled();
		expect(button.getAttribute("aria-label")).toBe("确认删除会话");
		expect(icon()).toBe(svg);
		await act(async () => button.click());
		expect(confirm).toHaveBeenCalledOnce();
		expect(button.getAttribute("aria-label")).toBe("删除会话");
	});
});
