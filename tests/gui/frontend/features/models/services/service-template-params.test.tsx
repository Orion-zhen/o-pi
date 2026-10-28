import { act, useState } from "react";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import { ServiceTemplateParams } from "../../../../../../src/gui/frontend/features/models/services/service-template-params.tsx";
import { ServiceThinkingFormat } from "../../../../../../src/gui/frontend/features/models/services/service-thinking-format.tsx";
import { TooltipProvider } from "../../../../../../src/gui/frontend/ui/tooltip.tsx";
import { serviceCompatSettings } from "../../../../../../src/harness/openai-compatible-provider/compat-settings.ts";
import { editModelsDocument } from "../../../../../../src/harness/openai-compatible-provider/config-edits.ts";
import { parseModelsDocument, type ConfigObject } from "../../../../../../src/harness/openai-compatible-provider/document.ts";
import { useReactFixture } from "../../../../helpers/react-fixture.ts";

const render = useReactFixture();
beforeEach(() => {
	vi.stubGlobal("HTMLFormElement", window.HTMLFormElement);
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
});
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const row = (name: string) => {
	const element = document.querySelector(`tr[aria-label="${name}"]`);
	return element?.closest('[aria-hidden="true"]') ? null : element;
};
const saved = () => parseModelsDocument(document.querySelector("output")?.textContent ?? "").providers.local;

it.each([
	["chat-template", "chatTemplateKwargs"],
	["baseten", "chatTemplateArgs"],
])("%s 快捷添加和删除只修改本层", async (format, key) => {
	const inherited = { enable_thinking: { $var: "thinking.enabled" } };
	function View() {
		const [content, setContent] = useState('{"providers":{"local":{"api":"openai-completions","models":[]}}}');
		const config = savedProvider(content);
		const defaults = serviceCompatSettings("local", { api: "openai-completions", compat: { thinkingFormat: format, [key]: inherited } }, { id: "m", defaults: {}, configured: config });
		return <TooltipProvider><ServiceThinkingFormat settings={defaults} disabled={false}
			change={(path, value) => setContent((current) => editModelsDocument(current, ["providers", "local", ...path], value))} />
			<output>{content}</output></TooltipProvider>;
	}
	await render(<View />);
	expect(row("enable_thinking")?.textContent).toContain("thinking.enabled");
	expect(row("enable_thinking")?.textContent).toContain("继承");
	expect(button("添加 enable_thinking")).toBeNull();
	expect(button("删除参数 enable_thinking")).toBeNull();
	expect(saved()).not.toHaveProperty("compat");
	await act(async () => button("添加 reasoning_effort")?.click());
	expect(saved()).toMatchObject({ compat: { [key]: { reasoning_effort: { $var: "thinking.effort" } } } });
	expect(saved()).not.toHaveProperty(`compat.${key}.enable_thinking`);
	expect(button("添加 reasoning_effort")).toBeNull();
	await act(async () => button("删除参数 reasoning_effort")?.click());
	expect(saved()).not.toHaveProperty(`compat.${key}`);
	expect(row("enable_thinking")?.textContent).toContain("继承");
	expect(button("添加 reasoning_effort")).not.toBeNull();
	await act(async () => button("添加 preserve_thinking")?.click());
	expect(saved()).toMatchObject({ compat: { [key]: { preserve_thinking: true } } });
	expect(button("添加 preserve_thinking")).toBeNull();
	expect(row("preserve_thinking")?.textContent).toContain("true");
	await act(async () => button("删除参数 preserve_thinking")?.click());
	expect(saved()).not.toHaveProperty(`compat.${key}`);
	expect(button("添加 preserve_thinking")).not.toBeNull();
});

function savedProvider(content: string): ConfigObject {
	const provider = parseModelsDocument(content).providers.local;
	if (!provider) throw new Error("缺少服务");
	return provider;
}

it("按键合并继承，重置覆盖后保留其他参数和注释", async () => {
	function View() {
		const [content, setContent] = useState('{\n// 保留自定义参数\n"providers":{"local":{"compat":{"chatTemplateKwargs":{"custom":"value","enable_thinking":false}}}}}');
		const provider = savedProvider(content);
		const compat = provider.compat as OpenAICompletionsCompat;
		return <TooltipProvider><ServiceTemplateParams label="chatTemplateKwargs" value={compat.chatTemplateKwargs}
			defaultValue={{ enable_thinking: { $var: "thinking.enabled" }, budget: { $var: "thinking.budget", omitWhenOff: true } }} disabled={false}
			change={(path, value) => setContent((current) => editModelsDocument(current, ["providers", "local", "compat", "chatTemplateKwargs", ...path], value))} />
			<output>{content}</output></TooltipProvider>;
	}
	await render(<View />);
	expect(row("enable_thinking")?.textContent).toContain("false");
	expect(row("enable_thinking")?.textContent).toContain("已覆盖");
	expect(row("budget")?.textContent).toContain("thinking.budget");
	expect(row("budget")?.textContent).toContain("omitWhenOff");
	await act(async () => button("重置参数 enable_thinking")?.click());
	expect(row("enable_thinking")?.textContent).toContain("thinking.enabled");
	expect(row("enable_thinking")?.textContent).toContain("继承");
	expect(saved()).toMatchObject({ compat: { chatTemplateKwargs: { custom: "value" } } });
	expect(saved()).not.toHaveProperty("compat.chatTemplateKwargs.enable_thinking");
	expect(document.querySelector("output")?.textContent).toContain("// 保留自定义参数");
	await act(async () => button("重置chatTemplateKwargs")?.click());
	expect(saved()).not.toHaveProperty("compat.chatTemplateKwargs");
	expect(row("custom")).toBeNull();
});

it("展示所有原生取值，不改写空字符串、false、0 或 null", async () => {
	const change = vi.fn();
	const value = { text: "", count: 0, flag: false, empty: null, budget: { $var: "thinking.budget", omitWhenOff: false } } as const;
	await render(<TooltipProvider><ServiceTemplateParams label="chatTemplateArgs" value={value} defaultValue={undefined} disabled={false} change={change} /></TooltipProvider>);
	for (const [name, text] of [["text", '""'], ["count", "0"], ["flag", "false"], ["empty", "null"], ["budget", "thinking.budget"]]) {
		expect(row(String(name))?.textContent).toContain(text);
	}
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(change).not.toHaveBeenCalled();
});

it("禁用时不可添加、编辑、删除或重置", async () => {
	await render(<TooltipProvider><ServiceTemplateParams label="chatTemplateKwargs" value={{ flag: false, custom: "text" }}
		defaultValue={{ flag: true }} disabled change={vi.fn()} /></TooltipProvider>);
	for (const label of ["添加参数", "添加 enable_thinking", "添加 preserve_thinking", "编辑参数 flag", "重置参数 flag", "删除参数 custom", "重置chatTemplateKwargs"]) {
		expect(button(label)?.disabled, label).toBe(true);
	}
});
