import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { ModelManager } from "../../src/gui/frontend/features/models/model-manager.tsx";
import type { Send } from "../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "./react-fixture.ts";
import { guiModelFixture, guiSnapshot } from "./snapshot-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it("已选模型按实际索引移动，目录外模型仍可排序，未选模型没有移动操作", async () => {
	const send = vi.fn<Send>().mockResolvedValue(true);
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
