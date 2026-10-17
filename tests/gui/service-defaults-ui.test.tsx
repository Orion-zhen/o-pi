import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { parseModelsDocument, type ConfigObject } from "../../src/harness/openai-compatible-provider/document.ts";
import { editModelsDocument } from "../../src/harness/openai-compatible-provider/config-edits.ts";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { ServiceCompat } from "../../src/gui/ui/model-services/service-compat.tsx";
import { serviceCompatDefaults } from "../../src/harness/openai-compatible-provider/compat-defaults.ts";
import { ServiceModels } from "../../src/gui/ui/model-services/service-models.tsx";
import { ServiceBoolean } from "../../src/gui/ui/model-services/service-fields.tsx";
import { useReactFixture } from "./react-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
const field = (label: string) => document.querySelector(`[role="combobox"][aria-label="${label}"]`);
const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const expand = async (label: string) => act(async () => {
	[...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label)?.click();
});

it("表单直接选中实际值，渲染不把默认值写入草稿", async () => {
	const change = vi.fn();
	const provider = { api: "openai-completions", baseUrl: "http://localhost/v1", models: [{ id: "m" }] };
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={change} /></TooltipProvider>);
	await act(async () => button("编辑模型 m")?.click());
	expect(toggle("思考能力")?.getAttribute("aria-checked")).toBe("false");
	expect(button("文本")?.getAttribute("aria-pressed")).toBe("true");
	expect(button("图片")?.getAttribute("aria-pressed")).toBe("false");
	expect(field("默认思考等级")?.textContent).toBe("不指定");
	const maxTokens = document.querySelector<HTMLInputElement>('input[aria-label="最大输出 Token"]');
	expect(maxTokens?.value).toBe("");
	expect(maxTokens?.placeholder).toBe("不限制（由服务端决定）");
	await expand("协议与思考");
	for (const [label, value] of [["思考传递方式", "auto"], ["输出上限字段", "max_completion_tokens"]]) {
		expect(field(String(label))?.textContent).toBe(value);
	}
	for (const label of ["Developer 角色", "服务端存储", "思考强度参数"]) {
		expect(toggle(label)?.getAttribute("aria-checked")).toBe("true");
		expect(field(label)).toBeNull();
	}
	expect(field("思考格式")).toBeNull();
	expect(field("思考编码")).toBeNull();
	expect(change).not.toHaveBeenCalled();
	expect(button("重置思考能力")).toBeNull();
	await act(async () => button("图片")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "input"], ["text", "image"]);
	await act(async () => button("文本")?.click());
	expect(change).toHaveBeenLastCalledWith(["models", 0, "input"], []);
});

it("模型覆盖继承模型定义及服务，服务地址改变后立即更新", async () => {
	const provider: ConfigObject = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1",
		models: [{ id: "m", reasoning: true, input: ["text", "image"], maxTokens: 8192, compat: { supportsStore: true } }], modelOverrides: { m: {} } };
	const view = () => <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={vi.fn()} /></TooltipProvider>;
	await render(view());
	await act(async () => button("编辑模型 m")?.click());
	await expand("协议与思考");
	expect(document.querySelector<HTMLInputElement>('input[aria-label="最大输出 Token"]')?.placeholder).toBe("继承：8192");
	expect(toggle("思考能力")?.getAttribute("aria-checked")).toBe("true");
	expect(button("文本")?.getAttribute("aria-pressed")).toBe("true");
	expect(button("图片")?.getAttribute("aria-pressed")).toBe("true");
	expect(field("思考传递方式")?.textContent).toBe("auto");
	expect(field("输出上限字段")?.textContent).toBe("max_tokens");
	expect(toggle("服务端存储")?.getAttribute("aria-checked")).toBe("true");
	provider.baseUrl = "http://localhost/v1";
	await render(view());
	expect(field("思考传递方式")?.textContent).toBe("auto");
	expect(field("输出上限字段")?.textContent).toBe("max_completion_tokens");
});

it("思考传递方式只编辑 thinkingPreset，重置后恢复模型定义", async () => {
	const change = vi.fn();
	const provider = { api: "openai-completions", thinkingPreset: "deepseek" };
	const model = { id: "m", defaults: { thinkingPreset: "qwen" }, configured: { thinkingPreset: "openai" } };
	await render(<TooltipProvider><ServiceCompat config={model.configured} defaults={serviceCompatDefaults("local", provider, model)} disabled={false} change={change} /></TooltipProvider>);
	await expand("协议与思考");
	expect(field("思考传递方式")?.textContent).toBe("openai");
	await act(async () => button("重置思考传递方式")?.click());
	expect(change).toHaveBeenCalledExactlyOnceWith(["thinkingPreset"], undefined);
	await render(<TooltipProvider><ServiceCompat config={{}} defaults={serviceCompatDefaults("local", provider, { ...model, configured: {} })} disabled={false} change={change} /></TooltipProvider>);
	expect(field("思考传递方式")?.textContent).toBe("qwen");
	expect(field("思考格式")).toBeNull();
});

it("布尔覆盖可重置回继承，禁用时不能重置", async () => {
	const change = vi.fn();
	function View({ disabled }: { disabled: boolean }) {
		const [value, setValue] = useState<boolean | undefined>(false);
		return <TooltipProvider><ServiceBoolean label="能力" value={value} defaultValue={true} disabled={disabled} change={(next) => {
			change(next); setValue(next);
		}} /></TooltipProvider>;
	}
	await render(<View disabled />);
	expect(button("重置能力")?.disabled).toBe(true);
	expect(toggle("能力")?.disabled).toBe(true);
	expect(toggle("能力")?.getAttribute("aria-checked")).toBe("false");
	await render(<View disabled={false} />);
	await act(async () => button("重置能力")?.click());
	expect(change).toHaveBeenCalledExactlyOnceWith(undefined);
	expect(toggle("能力")?.getAttribute("aria-checked")).toBe("true");
	expect(button("重置能力")).toBeNull();
	await act(async () => toggle("能力")?.click());
	expect(change).toHaveBeenLastCalledWith(false);
	expect(toggle("能力")?.getAttribute("aria-checked")).toBe("false");
	await act(async () => toggle("能力")?.click());
	expect(change).toHaveBeenLastCalledWith(undefined);
	expect(toggle("能力")?.getAttribute("aria-checked")).toBe("true");
	expect(button("重置能力")).toBeNull();
});

it("默认值因模型而异时可显式开关并重置回提示", async () => {
	const change = vi.fn();
	function View() {
		const [value, setValue] = useState<boolean | undefined>();
		return <TooltipProvider><ServiceBoolean label="能力" value={value} defaultValue={undefined} placeholder="因模型而异" disabled={false}
			change={(next) => { change(next); setValue(next); }} /></TooltipProvider>;
	}
	const hint = () => toggle("能力")?.getAttribute("aria-describedby");
	await render(<View />);
	expect(hint()).toBeTruthy();
	expect(change).not.toHaveBeenCalled();
	await act(async () => toggle("能力")?.click());
	expect(change).toHaveBeenLastCalledWith(true);
	expect(hint()).toBeNull();
	await act(async () => toggle("能力")?.click());
	expect(change).toHaveBeenLastCalledWith(false);
	expect(hint()).toBeNull();
	await act(async () => button("重置能力")?.click());
	expect(change).toHaveBeenLastCalledWith(undefined);
	expect(hint()).toBeTruthy();
	expect(button("重置能力")).toBeNull();
});

it("清空显式输出上限后，草稿删除配置并恢复不限提示", async () => {
	function View() {
		const [content, setContent] = useState('{"providers":{"local":{"api":"openai-completions","models":[{"id":"m","maxTokens":8192}]}}}');
		const provider = parseModelsDocument(content).providers.local;
		if (!provider) throw new Error("缺少服务");
		return <TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false}
			change={(path, value) => setContent((current) => editModelsDocument(current, ["providers", "local", ...path], value))} />
			<output>{content}</output></TooltipProvider>;
	}
	await render(<View />);
	await act(async () => button("编辑模型 m")?.click());
	const input = document.querySelector<HTMLInputElement>('input[aria-label="最大输出 Token"]');
	expect(input?.value).toBe("8192");
	await act(async () => button("重置最大输出 Token")?.click());
	expect(input?.value).toBe("");
	expect(input?.placeholder).toBe("不限制（由服务端决定）");
	expect(JSON.parse(document.querySelector("output")?.textContent ?? "").providers.local.models).toEqual([{ id: "m" }]);
});

it("显式配置等于默认值时，文本、选项和模型整体不显示重置按钮", async () => {
	const provider = { api: "openai-completions", models: [{ id: "m", maxTokens: 8192 }], modelOverrides: { m: {
		name: "m", contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false,
		thinkingPreset: "auto", compat: { maxTokensField: "max_completion_tokens", supportsStore: true },
	} } };
	await render(<TooltipProvider><ServiceModels providerId="local" provider={provider} candidates={[]} disabled={false} change={vi.fn()} /></TooltipProvider>);
	await act(async () => button("编辑模型 m")?.click());
	await expand("协议与思考");
	for (const label of ["模型名称", "上下文 Token", "最大输出 Token", "输入类型", "思考能力", "思考传递方式", "输出上限字段", "服务端存储"]) {
		expect(button(`重置${label}`), label).toBeNull();
	}
	expect(button("还原模型设置 m")).toBeNull();
});

it("模型默认值不一致时服务级显示因模型而异", async () => {
	const provider = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/m" }, { id: "other/m" }] };
	await render(<TooltipProvider><ServiceCompat config={provider} defaults={serviceCompatDefaults("local", provider)} disabled={false} change={vi.fn()} /></TooltipProvider>);
	await expand("协议与思考");
	const control = toggle("Developer 角色");
	expect(control).not.toBeNull();
	const descriptionId = control?.getAttribute("aria-describedby");
	expect(descriptionId && document.getElementById(descriptionId)?.textContent).toBe("因模型而异");
});
