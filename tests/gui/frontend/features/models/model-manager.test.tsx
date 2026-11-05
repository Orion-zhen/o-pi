import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { ModelManager } from "../../../../../src/gui/frontend/features/models/model-manager.tsx";
import type { Send } from "../../../../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "../../../helpers/react-fixture.ts";
import { guiModelFixture, guiSnapshot } from "../../../helpers/snapshot-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it("保存失败在模型区域保留原文，重试成功清除错误并恢复按钮", async () => {
	const failure = "EACCES: permission denied\n/workspace/models.json";
	const send = vi.fn<Send>().mockRejectedValueOnce(new Error(failure)).mockResolvedValue(undefined);
	const snapshot = { ...guiSnapshot(), modelScopeChanged: true };
	await render(<TooltipProvider><ModelManager snapshot={snapshot} send={send} disabled={false} /></TooltipProvider>);
	const save = document.querySelector<HTMLButtonElement>(".model-manager-footer button");
	if (!save) throw new Error("缺少保存按钮");
	await act(async () => save.click());
	expect(document.querySelector('[role="alert"]')?.textContent).toBe(failure);
	expect(save.disabled).toBe(false);
	await act(async () => save.click());
	expect(send).toHaveBeenCalledTimes(2);
	expect([...document.querySelectorAll('[role="alert"]')].filter((element) => !element.closest('[aria-hidden="true"]'))).toEqual([]);
	expect(save.disabled).toBe(false);
});

it("同一轮连续提交只执行一次，卸载不会取消已提交保存", async () => {
	const result = Promise.withResolvers<void>();
	const send = vi.fn<Send>(() => result.promise);
	await render(<TooltipProvider><ModelManager snapshot={{ ...guiSnapshot(), modelScopeChanged: true }} send={send} disabled={false} /></TooltipProvider>);
	const save = document.querySelector<HTMLButtonElement>(".model-manager-footer button");
	if (!save) throw new Error("缺少保存按钮");
	await act(async () => { save.click(); save.click(); });
	expect(send).toHaveBeenCalledTimes(1);
	await render(null);
	await act(async () => result.resolve());
	expect(send).toHaveBeenCalledTimes(1);
});

it("已选模型按实际索引移动，目录外模型仍可排序，未选模型没有移动操作", async () => {
	const send = vi.fn<Send>().mockResolvedValue(undefined);
	const snapshot = { ...guiSnapshot(), scopedModels: ["local/first", "local/missing", "local/last"],
		models: ["first", "last", "other"].map((id) => guiModelFixture({ provider: "local", id, name: id, contextWindow: 1000 })) };
	const view = () => <TooltipProvider><ModelManager snapshot={snapshot} send={send} disabled={false} /></TooltipProvider>;
	await render(view());
	expect(button("上移 local/first")?.disabled).toBe(true);
	expect(button("下移 local/last")?.disabled).toBe(true);
	expect(button("上移 local/other")).toBeNull();
	expect(button("下移 local/other")).toBeNull();
	const up = button("上移 local/missing");
	if (!up) throw new Error("缺少上移按钮");
	await act(async () => up.click());
	expect(send).toHaveBeenLastCalledWith({ action: "scopeModels", models: ["local/missing", "local/first", "local/last"] });

	snapshot.scopedModels = ["local/missing", "local/first", "local/last"];
	await render(view());
	expect(button("上移 local/missing")?.disabled).toBe(true);
	const down = button("下移 local/missing");
	if (!down) throw new Error("缺少下移按钮");
	await act(async () => down.click());
	expect(send).toHaveBeenLastCalledWith({ action: "scopeModels", models: ["local/first", "local/missing", "local/last"] });
});
