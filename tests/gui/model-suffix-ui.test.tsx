import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelServiceCatalog } from "../../src/gui/model-services.ts";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/document.ts";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { ServiceForm } from "../../src/gui/ui/model-services/service-form.tsx";
import { ServiceModels } from "../../src/gui/ui/model-services/service-models.tsx";
import { modelCandidates } from "../../src/harness/openai-compatible-provider/model-candidates.ts";
import type { CatalogQuery } from "../../src/gui/ui/model-services/use-service-catalog.ts";
import { deferred } from "../helpers/async.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
const provider = { models: [{ id: "m" }], api: "openai-completions", thinkingPreset: "model-suffix" };
const candidates = ["m", "m:low", "m:xhigh"].map((id) => ({ id }));

it("渲染设置只展示配置，不因候选或可见性写回草稿", async () => {
	const change = vi.fn();
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={modelCandidates(provider, candidates)}
		disabled={false} change={change} /></TooltipProvider>);
	expect(change).not.toHaveBeenCalled();
});

it("候选异步到达时只更新一次草稿，恢复默认映射在同一次编辑中完成", async () => {
	const pending = deferred<ModelServiceCatalog>();
	const query = vi.fn<CatalogQuery>().mockReturnValue(pending.promise);
	const updates = vi.fn();
	function View() {
		const [content, setContent] = useState(JSON.stringify({ providers: { local: provider } }));
		const config = parseModelsDocument(content).providers.local;
		if (!config) throw new Error("缺少服务");
		return <TooltipProvider><ServiceForm id="local" config={config} disabled={false} sessionId="session" savedContent="saved" query={query}
			changeDraft={(update) => {
				updates(); setContent(update);
			}} /><output>{content}</output></TooltipProvider>;
	}
	await render(<View />);
	expect(document.querySelector("output")?.textContent).not.toContain("thinkingLevelMap");
	await act(async () => pending.resolve({ candidates, error: "", reloadRequired: false }));
	expect(updates).toHaveBeenCalledOnce();
	expect(JSON.parse(document.querySelector("output")?.textContent ?? "")).toMatchObject({ providers: { local: { models: [{ id: "m", reasoning: true,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null },
	}] } } });
	await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="编辑模型 m"]')?.click());
	await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "思考等级映射")?.click());
	const enabled = (level: string) => document.querySelector<HTMLButtonElement>(`[aria-label="在 opi 中启用 ${level}"]`);
	expect(enabled("minimal")?.getAttribute("aria-checked")).toBe("false");
	expect(enabled("high")?.getAttribute("aria-checked")).toBe("false");
	expect(enabled("xhigh")?.getAttribute("aria-checked")).toBe("true");
	await act(async () => enabled("xhigh")?.click());
	expect(enabled("xhigh")?.getAttribute("aria-checked")).toBe("false");
	await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "恢复默认映射")?.click());
	expect(enabled("xhigh")?.getAttribute("aria-checked")).toBe("true");
	expect(enabled("high")?.getAttribute("aria-checked")).toBe("false");
	expect(updates).toHaveBeenCalledTimes(3);
	expect(query).toHaveBeenCalledOnce();
});
