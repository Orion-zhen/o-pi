import { act, type ComponentProps } from "react";
import type { SourceEditor } from "../../src/gui/frontend/forms/source-editor.tsx";
import { beforeEach, expect, it, vi } from "vitest";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/document.ts";
import { modelsConfigSchema } from "../../src/harness/openai-compatible-provider/config.ts";
import type { Query } from "../../src/gui/shared/protocol/queries.ts";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { ModelServicesSettings } from "../../src/gui/frontend/features/models/services/model-services-settings.tsx";
import { SettingsStateContext, useSettingsCoordinator } from "../../src/gui/frontend/forms/drafts.tsx";
import { SettingsActions } from "../../src/gui/frontend/forms/settings-controls.tsx";
import type { Send } from "../../src/gui/frontend/connection/connection.ts";
import { useReactFixture } from "./react-fixture.ts";
import type { CatalogQuery } from "../../src/gui/frontend/features/models/services/use-service-catalog.ts";
import type { ModelServiceCatalog } from "../../src/gui/shared/config/model-services.ts";
import { deferred } from "../helpers/async.ts";

vi.mock("../../src/gui/frontend/forms/source-editor.tsx", () => ({
	SourceEditor: ({ label, value, disabled, onChange }: ComponentProps<typeof SourceEditor>) =>
		<textarea aria-label={label} value={value} disabled={disabled} onInput={(event) => onChange(event.currentTarget.value)} />,
}));

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
function View({ query, send, catalogQuery = sessionQuery, sessionId, revision = 0, ready = !!sessionId }: {
	query: Query<{ query: "modelServices" }>; send: Send; catalogQuery?: CatalogQuery; sessionId?: string; revision?: number; ready?: boolean;
}) {
	const state = useSettingsCoordinator(dirty);
	return <TooltipProvider><SettingsStateContext.Provider value={state}>
		<ModelServicesSettings globalQuery={query} query={catalogQuery} send={send} disabled={false} sessionId={sessionId}
			sessionRevision={revision} sessionReady={ready} />
		<SettingsActions count={state.dirtyPages.size} saving={state.saving} blocked={state.blocked} disabled={false}
			error={state.error} status={state.status} save={state.save} discard={state.discard} />
	</SettingsStateContext.Provider></TooltipProvider>;
}

it.each([
	"{",
	JSON.stringify({ providers: { local: { api: "openai-completions", compat: null } } }),
	JSON.stringify({ providers: { local: { api: "openai-completions", compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enabled: [] } } } } }),
])("加载未通过校验的配置只能编辑源码 %#", async (content) => {
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema });
	const send = vi.fn<Send>();
	await render(<View query={query} send={send} />);
	expect(document.querySelector<HTMLTextAreaElement>("textarea")?.defaultValue).toBe(content);
	expect(named("表单")?.disabled).toBe(true);
	expect(named("添加服务")).toBeUndefined();
	expect(button("编辑服务 local")).toBeNull();
	expect(document.querySelector('[role="alert"]')).not.toBeNull();
	expect(named("保存")?.disabled).toBe(true);
	expect(send).not.toHaveBeenCalled();
});

it("服务级配置位于候选模型操作和模型配置上方", async () => {
	const content = JSON.stringify({ providers: { local: { api: "openai-completions", models: [{ id: "m" }] } } });
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema });
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
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema });
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
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema });
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
	const query = vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema });
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

const badge = () => document.querySelector<HTMLButtonElement>(".service-connection");
function connectionFixture() {
	const content = JSON.stringify({ providers: { local: {
		api: "openai-completions", baseUrl: "http://localhost/v1", apiKey: "local", models: [{ id: "m" }],
	} } });
	const value: ModelServiceCatalog = {
		candidates: [{ id: "m", contextWindow: 8192 }, { id: "remote" }], changes: "none",
		connection: { status: "connected", httpStatus: 200, checkedAt: Date.now(), latencyMs: 12 },
	};
	return {
		query: vi.fn<Query<{ query: "modelServices" }>>().mockResolvedValue({ path: "models.json", content, schema: modelsConfigSchema }),
		catalogQuery: vi.fn<CatalogQuery>().mockResolvedValue(value), send: vi.fn<Send>().mockResolvedValue(true), value,
	};
}

it("收起的服务自动检测但不修改草稿，点击 badge 重测不会展开，表单复用候选", async () => {
	const fixture = connectionFixture();
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("已连接");
	expect(badge()?.getAttribute("data-tone")).toBe("success");
	expect(button("编辑服务 local")?.getAttribute("aria-expanded")).toBe("false");
	expect(named("保存")?.disabled).toBe(true);
	expect(fixture.catalogQuery).toHaveBeenCalledOnce();
	await click(badge());
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
	expect(button("编辑服务 local")?.getAttribute("aria-expanded")).toBe("false");
	expect(named("保存")?.disabled).toBe(true);
	await click(button("编辑服务 local"));
	expect(button("编辑服务 local")?.getAttribute("aria-expanded")).toBe("true");
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
	await click(named("添加模型"));
	await act(async () => document.querySelector<HTMLInputElement>('[aria-label="模型 ID"]')?.click());
	expect(document.querySelector('[role="option"]')?.textContent).toBe("remote");
	const pending = deferred<ModelServiceCatalog>();
	fixture.catalogQuery.mockReturnValueOnce(pending.promise);
	await click(named("重新获取"));
	expect(badge()?.textContent).toBe("检测中");
	expect(named("重新获取")?.disabled).toBe(true);
	expect(document.querySelector('[role="option"]')?.textContent).toBe("remote");
	await act(async () => { pending.resolve(fixture.value); });
	expect(badge()?.textContent).toBe("已连接");
});

it("连接修改后显示待保存，保存后显示待重载，重载后自动更新状态", async () => {
	const fixture = connectionFixture();
	await render(<View {...fixture} sessionId="first" />);
	await click(button("编辑服务 local"));
	await click(named("请求设置"));
	await click(button("强制 Bearer 认证"));
	expect(badge()?.textContent).toBe("待保存");
	expect(badge()?.getAttribute("aria-disabled")).toBe("true");
	expect(named("重新获取")?.disabled).toBe(true);
	await click(badge());
	expect(fixture.catalogQuery).toHaveBeenCalledOnce();
	fixture.catalogQuery.mockResolvedValueOnce({ ...fixture.value, changes: "connection" });
	await click(named("保存"));
	expect(badge()?.textContent).toBe("待重载");
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
	await render(<View {...fixture} sessionId="first" revision={1} ready={false} />);
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
	expect(badge()?.getAttribute("aria-disabled")).toBe("true");
	await render(<View {...fixture} sessionId="first" revision={1} ready />);
	expect(badge()?.textContent).toBe("已连接");
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(3);
});

it("会话未就绪或正在检测时，两个重试入口都禁用，就绪变化不重复检测", async () => {
	const fixture = connectionFixture();
	const pending = deferred<ModelServiceCatalog>();
	fixture.catalogQuery.mockReturnValueOnce(pending.promise);
	await render(<View {...fixture} sessionId="first" ready={false} />);
	await click(button("编辑服务 local"));
	const expectRetryDisabled = (disabled: boolean) => {
		expect(badge()?.getAttribute("aria-disabled")).toBe(String(disabled));
		expect(named("重新获取")?.disabled).toBe(disabled);
	};
	expectRetryDisabled(true);
	await click(badge());
	expect(fixture.catalogQuery).not.toHaveBeenCalled();
	await render(<View {...fixture} sessionId="first" ready />);
	expect(badge()?.textContent).toBe("检测中");
	expectRetryDisabled(true);
	await act(async () => { pending.resolve(fixture.value); });
	expectRetryDisabled(false);
	await render(<View {...fixture} sessionId="first" ready={false} />);
	expectRetryDisabled(true);
	await render(<View {...fixture} sessionId="first" ready />);
	expectRetryDisabled(false);
	expect(fixture.catalogQuery).toHaveBeenCalledOnce();
	await click(named("重新获取"));
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
	expect(badge()?.textContent).toBe("已连接");
});

it("仅模型配置待重载时保留连接状态，表单单独提示重载", async () => {
	const fixture = connectionFixture();
	fixture.catalogQuery.mockResolvedValue({ ...fixture.value, changes: "models" });
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("已连接");
	await click(button("编辑服务 local"));
	expect(document.querySelector(".service-form > .service-tag")?.textContent).toBe("待重载");
});

it.each([
	["unavailable", "connection", "待重载", "请先保存并重载新服务"],
	["unconfigured", "none", "未配置认证", "请先配置认证"],
] as const)("%s 检测结果与 %s 配置差异分别决定提示", async (status, changes, label, message) => {
	const fixture = connectionFixture();
	fixture.catalogQuery.mockResolvedValue({ ...fixture.value, candidates: [], changes, connection: { status } });
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe(label);
	await click(button("编辑服务 local"));
	expect(document.querySelector(".service-form")?.textContent).toContain(message);
	expect(document.querySelector(".service-form > .service-tag")).toBeNull();
});

it("查询失败显示安全文案，手动重试恢复连接状态", async () => {
	const fixture = connectionFixture();
	fixture.catalogQuery.mockRejectedValueOnce(new Error("sk-secret"));
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("检测失败");
	await click(button("编辑服务 local"));
	expect(document.querySelector(".service-form")?.textContent).toContain("获取候选模型失败，可重试或手动填写模型 ID");
	expect(document.body.textContent).not.toContain("sk-secret");
	await render(<View {...fixture} sessionId="first" ready={false} />);
	await render(<View {...fixture} sessionId="first" ready />);
	expect(fixture.catalogQuery).toHaveBeenCalledOnce();
	await click(named("重新获取"));
	expect(badge()?.textContent).toBe("已连接");
	expect(document.querySelector(".service-form")?.textContent).not.toContain("获取候选模型失败");
});

it("无会话显示未检测，不发起请求", async () => {
	const fixture = connectionFixture();
	await render(<View {...fixture} />);
	expect(badge()?.textContent).toBe("未检测");
	await click(badge());
	expect(fixture.catalogQuery).not.toHaveBeenCalled();
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("已连接");
	expect(fixture.catalogQuery).toHaveBeenCalledOnce();
});

it("在途检测不能覆盖连接草稿的待保存状态", async () => {
	const fixture = connectionFixture();
	const pending = deferred<ModelServiceCatalog>();
	fixture.catalogQuery.mockReturnValueOnce(pending.promise);
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("检测中");
	await click(button("编辑服务 local"));
	await click(named("请求设置"));
	await click(button("强制 Bearer 认证"));
	await act(async () => { pending.resolve(fixture.value); });
	expect(badge()?.textContent).toBe("待保存");
	expect(button("强制 Bearer 认证")?.getAttribute("aria-checked")).toBe("true");
	await click(named("放弃"));
	expect(badge()?.textContent).toBe("已连接");
	expect(fixture.catalogQuery).toHaveBeenCalledTimes(2);
});

it("服务拒绝认证后显示失败提示，重试成功后恢复连接状态", async () => {
	const fixture = connectionFixture();
	fixture.catalogQuery.mockResolvedValueOnce({ ...fixture.value, candidates: [], connection: {
		status: "auth-failed", checkedAt: Date.now(), latencyMs: 10, httpStatus: 401,
	} });
	await render(<View {...fixture} sessionId="first" />);
	expect(badge()?.textContent).toBe("认证失败");
	expect(badge()?.getAttribute("data-tone")).toBe("error");
	await click(button("编辑服务 local"));
	expect(document.querySelector(".service-form")?.textContent).toContain("获取候选模型失败，可重试或手动填写模型 ID");
	await click(named("重新获取"));
	expect(badge()?.textContent).toBe("已连接");
});

it.each(["success", "failure"] as const)("切换会话清除旧候选，旧检测的 %s 不覆盖新会话", async (outcome) => {
	const fixture = connectionFixture();
	const previous = Promise.withResolvers<ModelServiceCatalog>();
	const current = deferred<ModelServiceCatalog>();
	await render(<View {...fixture} sessionId="first" />);
	await click(button("编辑服务 local"));
	await click(named("添加模型"));
	await act(async () => document.querySelector<HTMLInputElement>('[aria-label="模型 ID"]')?.click());
	expect(document.querySelector('[role="option"]')?.textContent).toBe("remote");
	fixture.catalogQuery.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
	await click(badge());
	await render(<View {...fixture} sessionId="second" />);
	expect(badge()?.textContent).toBe("检测中");
	expect(document.querySelector('[role="listbox"]:not([aria-hidden="true"])')).toBeNull();
	await act(async () => { current.resolve({ ...fixture.value, candidates: [{ id: "current" }] }); });
	await act(async () => {
		if (outcome === "success") previous.resolve({ ...fixture.value, candidates: [{ id: "previous" }] });
		else previous.reject(new Error("旧会话请求失败"));
	});
	expect(badge()?.textContent).toBe("已连接");
	expect(document.querySelector('[role="listbox"]:not([aria-hidden="true"])')?.textContent).toBe("current");
});
