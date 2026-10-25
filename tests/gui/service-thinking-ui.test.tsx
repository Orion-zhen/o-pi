import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { ServiceModels } from "../../src/gui/frontend/features/models/services/service-models.tsx";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import type { ConfigObject } from "../../src/harness/openai-compatible-provider/document.ts";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const input = (level: string) => document.querySelector<HTMLInputElement>(`input[aria-label="opi ${level} 对应的服务商值"]`);
const row = (level: string) => button(`在 opi 中启用 ${level}`)?.closest("tr");
const expand = async (label: string) => act(async () => {
	[...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label)?.click();
});

it("开关模板不允许编辑映射，切换模板保留配置，失效覆盖仍可重置", async () => {
	const change = vi.fn();
	const provider: ConfigObject = { api: "openai-completions", compat: { thinkingFormat: "qwen-chat-template" },
		models: [{ id: "m", reasoning: true, thinkingLevelMap: { high: "custom" }, compat: { supportsReasoningEffort: false } }] };
	const view = () => <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>;
	await render(view());
	await act(async () => button("编辑模型 m")?.click());
	await expand("思考等级映射");
	await expand("协议与思考");
	expect(input("high")).toBeNull();
	expect(input("off")).toBeNull();
	expect(row("high")?.textContent).toContain("开启思考");
	expect(row("off")?.textContent).toContain("关闭思考");
	expect(button("在 opi 中启用 high")?.disabled).toBe(false);
	expect(button("独立 reasoning_effort 参数")?.disabled).toBe(true);
	expect(change).not.toHaveBeenCalled();
	await act(async () => button("恢复默认映射")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "thinkingLevelMap"], undefined);
	await act(async () => button("恢复 high 默认映射")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "thinkingLevelMap", "high"], undefined);
	await act(async () => button("重置独立 reasoning_effort 参数")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "compat", "supportsReasoningEffort"], undefined);
	provider.compat = { thinkingFormat: "openrouter" };
	await render(view());
	expect(input("high")?.value).toBe("custom");
	expect(input("off")?.placeholder).toBe("none");
});

it("开关模板启用 max 只显示请求行为，重置后恢复不可选", async () => {
	const change = vi.fn();
	const model: ConfigObject = { id: "m", reasoning: true };
	const provider = { api: "openai-completions", compat: { thinkingFormat: "qwen-chat-template" }, models: [model] };
	const view = () => <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>;
	await render(view());
	await act(async () => button("编辑模型 m")?.click());
	await expand("思考等级映射");
	expect(button("在 opi 中启用 max")?.getAttribute("aria-checked")).toBe("false");
	await act(async () => button("在 opi 中启用 max")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "thinkingLevelMap", "max"], "max");
	model.thinkingLevelMap = { max: "max" };
	await render(view());
	expect(button("在 opi 中启用 max")?.getAttribute("aria-checked")).toBe("true");
	expect(row("max")?.textContent).toContain("开启思考");
	expect(input("max")).toBeNull();
	await act(async () => button("恢复 max 默认映射")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "thinkingLevelMap", "max"], undefined);
	model.thinkingLevelMap = {};
	await render(view());
	expect(button("在 opi 中启用 max")?.getAttribute("aria-checked")).toBe("false");
	expect(button("恢复 max 默认映射")).toBeNull();
});

it("DeepSeek 原生格式联动独立参数和映射，off 不出现无效输入", async () => {
	const change = vi.fn();
	const compat = { supportsReasoningEffort: false, thinkingFormat: "deepseek" };
	const provider = { api: "openai-completions", compat, models: [{ id: "m", reasoning: true }] };
	const view = () => <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>;
	await render(view());
	await act(async () => button("编辑模型 m")?.click());
	await expand("思考等级映射");
	await expand("协议与思考");
	expect(input("high")).toBeNull();
	expect(input("off")).toBeNull();
	expect(button("独立 reasoning_effort 参数")?.disabled).toBe(false);
	expect(button("恢复默认映射")).toBeNull();
	await act(async () => button("独立 reasoning_effort 参数")?.click());
	expect(change).toHaveBeenCalledExactlyOnceWith(["models", 0, "compat", "supportsReasoningEffort"], true);
	compat.supportsReasoningEffort = true;
	await render(view());
	expect(input("high")?.disabled).toBe(false);
	expect(input("high")?.placeholder).toBe("high");
	expect(input("off")).toBeNull();
	compat.thinkingFormat = "qwen-chat-template";
	await render(view());
	expect(input("high")).toBeNull();
	expect(row("high")?.textContent).toContain("开启思考");
	expect(button("在 opi 中启用 high")?.disabled).toBe(false);
	expect(change).toHaveBeenCalledTimes(1);
});

it("Responses 只展示原生等级映射，不显示格式或独立参数选择", async () => {
	const change = vi.fn();
	const provider = { api: "openai-responses", models: [{ id: "m", reasoning: true }] };
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>);
	await act(async () => button("编辑模型 m")?.click());
	await expand("协议与思考");
	await expand("思考等级映射");
	expect(button("思考格式")).toBeNull();
	expect(button("独立 reasoning_effort 参数")).toBeNull();
	expect(input("high")?.placeholder).toBe("high");
	expect(input("off")?.placeholder).toBe("none");
	expect(change).not.toHaveBeenCalled();
});

it.each(["anthropic-messages", "unknown-api"])("模型继承 %s 时隐藏 OpenAI 控件，覆盖为支持的 API 后恢复", async (api) => {
	const change = vi.fn();
	const override: ConfigObject = {};
	const provider = { api: "openai-completions", models: [{ id: "m", api, reasoning: true,
		compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enabled: { $var: "thinking.enabled" } } },
		thinkingLevelMap: { high: "custom" } }], modelOverrides: { m: override } };
	const original = JSON.stringify(provider);
	const view = () => <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>;
	await render(view());
	await act(async () => button("编辑模型 m")?.click());
	expect(button("思考格式")).toBeNull();
	expect(document.querySelector('[role="group"][aria-label="chatTemplateKwargs"]')).toBeNull();
	expect(document.querySelector(".service-thinking")).toBeNull();
	expect([...document.querySelectorAll("button")].some((entry) => entry.textContent === "协议与思考")).toBe(false);
	expect(button("默认思考等级")?.disabled).toBe(false);
	expect(JSON.stringify(provider)).toBe(original);
	expect(change).not.toHaveBeenCalled();

	override.api = "openai-completions";
	await render(view());
	expect(button("思考格式")?.textContent).toBe("chat-template");
	expect(document.querySelector('[role="group"][aria-label="chatTemplateKwargs"]')).not.toBeNull();
	await expand("协议与思考");
	expect(button("Developer 角色")).not.toBeNull();
	override.api = "openai-responses";
	await render(view());
	await expand("思考等级映射");
	expect(button("思考格式")).toBeNull();
	expect(input("high")?.placeholder).toBe("custom");
	expect(input("off")?.placeholder).toBe("none");
	expect(change).not.toHaveBeenCalled();
});

it.each(["openai", "chat-template", "ant-ling"])("%s 未配置显式映射时提示不发送等级值", async (thinkingFormat) => {
	const provider = { api: "openai-completions", compat: { thinkingFormat, chatTemplateKwargs: { effort: { $var: "thinking.effort" } } },
		models: [{ id: "m", reasoning: true }] };
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={vi.fn()} /></TooltipProvider>);
	await act(async () => button("编辑模型 m")?.click());
	await expand("思考等级映射");
	expect(input("off")?.placeholder).toBe("不发送等级值");
	expect(input("high")?.placeholder).toBe(thinkingFormat === "ant-ling" ? "不发送等级值" : "high");
});

it("未开启思考能力时禁用等级设置但保留重置入口", async () => {
	const change = vi.fn();
	const provider = { api: "openai-completions", models: [{ id: "m", defaultThinkingLevel: "high", thinkingLevelMap: { high: "custom" } }] };
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>);
	await act(async () => button("编辑模型 m")?.click());
	await expand("思考等级映射");
	await expand("协议与思考");
	expect(button("默认思考等级")?.disabled).toBe(true);
	expect(button("独立 reasoning_effort 参数")?.disabled).toBe(true);
	expect(button("在 opi 中启用 high")?.disabled).toBe(true);
	expect(input("high")?.disabled).toBe(true);
	expect(button("恢复 high 默认映射")?.disabled).toBe(false);
	expect(button("重置默认思考等级")?.disabled).toBe(false);
	expect(change).not.toHaveBeenCalled();
});
