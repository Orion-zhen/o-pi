import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/document.ts";
import type { Query } from "../../src/gui/contract.ts";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { ModelServicesSettings } from "../../src/gui/ui/model-services/model-services-settings.tsx";
import { SettingsStateContext, useSettingsCoordinator } from "../../src/gui/ui/settings/settings-state.tsx";
import { SettingsActions } from "../../src/gui/ui/settings/settings-controls.tsx";
import type { Send } from "../../src/gui/ui/runtime/connection.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
const click = async (element: HTMLButtonElement | undefined | null) => {
	expect(element).toBeTruthy();
	await act(async () => element?.click());
};
const dirty = vi.fn();
const sessionQuery: Query = async () => { throw new Error("无会话不应查询候选"); };
function View({ query, send }: { query: Query<{ query: "modelServices" }>; send: Send }) {
	const state = useSettingsCoordinator(dirty);
	return <TooltipProvider><SettingsStateContext.Provider value={state}>
		<ModelServicesSettings globalQuery={query} query={sessionQuery} send={send} disabled={false} sessionId={undefined} />
		<SettingsActions count={state.dirtyPages.size} saving={state.saving} blocked={state.blocked} disabled={false}
			error={state.error} status={state.status} save={state.save} discard={state.discard} />
	</SettingsStateContext.Provider></TooltipProvider>;
}

it("服务级配置位于候选模型操作和模型配置上方", async () => {
	const content = JSON.stringify({ providers: { local: { api: "openai-completions", models: [{ id: "m" }] } } });
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: Type.Unknown() });
	await render(<View query={query} send={vi.fn<Send>().mockResolvedValue(true)} />);
	await click(button("编辑服务 local"));
	const controls = [...document.querySelectorAll("button")];
	const sections = [named("协议与思考"), named("请求设置"), named("重新获取"), button("编辑模型 m")];
	for (const section of sections) expect(section).toBeTruthy();
	const positions = sections.map((section) => controls.findIndex((control) => control === section));
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
	const heading = named("重新获取")?.closest("header");
	expect(heading?.querySelector("h4")?.textContent).toBe("模型");
	expect(heading?.querySelector('[role="status"]')?.textContent).toBe("1 个模型");
	expect(heading?.contains(named("添加模型") ?? null)).toBe(true);
	const provider = button("编辑服务 local");
	const model = button("编辑模型 m");
	await click(model);
	await click(named("采样参数"));
	const sampling = named("采样参数");
	await click(button("思考能力"));
	await click(named("保存"));
	for (const control of [provider, model, sampling]) expect(control?.getAttribute("aria-expanded")).toBe("true");
	expect(button("编辑模型 m")).toBe(model);
	await click(button("思考能力"));
	await click(named("放弃"));
	for (const control of [provider, model, sampling]) expect(control?.getAttribute("aria-expanded")).toBe("true");
	expect(button("编辑模型 m")).toBe(model);
	expect(named("采样参数")).toBe(sampling);
	expect(button("思考能力")?.getAttribute("aria-checked")).toBe("true");
});

it.each([undefined, false, true])("开关改回保存值 %s 后不再保存，默认值不显示重置按钮", async (authHeader) => {
	const content = JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: "http://localhost/v1", authHeader } } });
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: Type.Unknown() });
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<View query={query} send={send} />);
	await click(button("编辑服务 local"));
	await click(named("请求设置"));
	expect(named("保存")?.disabled).toBe(true);
	expect(!!button("重置强制 Bearer 认证")).toBe(authHeader === true);
	await click(button("强制 Bearer 认证"));
	expect(named("保存")?.disabled).toBe(false);
	expect(!!button("重置强制 Bearer 认证")).toBe(authHeader !== true);
	await click(button("强制 Bearer 认证"));
	expect(named("保存")?.disabled).toBe(true);
	await click(named("保存"));
	expect(send).not.toHaveBeenCalled();
	await click(named("JSON"));
	expect(document.querySelector<HTMLTextAreaElement>("textarea")?.defaultValue).toBe(content);
	expect(named("保存")?.disabled).toBe(true);
});

it("一个字段改回原值不会清除其他字段的待保存修改", async () => {
	const content = '{\n// 保留注释\n"providers":{"local":{"api":"openai-completions"}}\n}';
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: Type.Unknown() });
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<View query={query} send={send} />);
	await click(button("编辑服务 local"));
	await click(named("协议与思考"));
	await click(button("服务端存储"));
	await click(named("请求设置"));
	await click(button("强制 Bearer 认证"));
	await click(button("强制 Bearer 认证"));
	expect(named("保存")?.disabled).toBe(false);
	await click(named("保存"));
	const action = send.mock.calls[0]?.[0];
	if (action?.action !== "saveModelServices") throw new Error("未保存模型服务");
	expect(action.original).toBe(content);
	expect(action.content).toContain("// 保留注释");
	expect(parseModelsDocument(action.content).providers.local).toEqual({ api: "openai-completions", compat: { supportsStore: false } });
	expect(named("保存")?.disabled).toBe(true);
	await click(button("服务端存储"));
	expect(named("保存")?.disabled).toBe(false);
	await click(button("服务端存储"));
	expect(named("保存")?.disabled).toBe(true);
});

it("改回默认值不同于已保存值时隐藏重置按钮，但仍需保存", async () => {
	const content = JSON.stringify({ providers: { local: { api: "openai-completions", authHeader: true } } });
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: Type.Unknown() });
	const send = vi.fn<Send>().mockResolvedValue(true);
	await render(<View query={query} send={send} />);
	await click(button("编辑服务 local"));
	await click(named("请求设置"));
	await click(button("强制 Bearer 认证"));
	expect(button("重置强制 Bearer 认证")).toBeNull();
	expect(named("保存")?.disabled).toBe(false);
	await click(named("保存"));
	expect(send).toHaveBeenCalledOnce();
	const action = send.mock.calls[0]?.[0];
	expect(action?.action).toBe("saveModelServices");
	if (action?.action !== "saveModelServices") throw new Error("未保存模型服务");
	expect(action.original).toBe(content);
	expect(JSON.parse(action.content).providers.local.authHeader).toBeUndefined();
	expect(named("保存")?.disabled).toBe(true);
});
