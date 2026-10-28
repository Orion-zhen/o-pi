import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Send } from "../../../../../../src/gui/frontend/connection/connection.ts";
import { ToolSelection } from "../../../../../../src/gui/frontend/features/chat/tools/tool-selection.tsx";
import { deferred } from "../../../../../helpers/async.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";
import { guiSnapshot } from "../../../../helpers/snapshot-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const snapshot = { ...guiSnapshot(), toolPreset: "vanilla" as const, toolDefaultsChanged: true };
function button(label: string): HTMLButtonElement {
	const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
	if (!element) throw new Error(`缺少按钮 ${label}`);
	return element;
}

it("禁用时不提交预设，点击已选预设不取消或重复提交", async () => {
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<ToolSelection snapshot={snapshot} send={send} disabled />);
	expect(button("Offline").disabled).toBe(true);
	await act(async () => button("Offline").click());
	expect(send).not.toHaveBeenCalled();

	await render(<ToolSelection snapshot={snapshot} send={send} disabled={false} />);
	await act(async () => button("Vanilla").click());
	expect(button("Vanilla").getAttribute("aria-checked")).toBe("true");
	expect(send).not.toHaveBeenCalled();
});

it.each([
	{ label: "Offline", action: { action: "toolPreset", preset: "offline" } as const, success: true },
	{ label: "保存默认", action: { action: "persistTools" } as const, success: false },
])("$label 请求期间禁止重复操作，结束后恢复", async ({ label, action, success }) => {
	const result = deferred<boolean>();
	const send = vi.fn<Send>(() => result.promise);
	await render(<ToolSelection snapshot={snapshot} send={send} disabled={false} />);
	await act(async () => button(label).click());
	expect(send).toHaveBeenCalledExactlyOnceWith(action);
	for (const name of ["Offline", "保存默认"]) expect(button(name).disabled).toBe(true);
	await act(async () => button("Offline").click());
	expect(send).toHaveBeenCalledTimes(1);

	await act(async () => result.resolve(success));
	for (const name of ["Offline", "保存默认"]) expect(button(name).disabled).toBe(false);
});
