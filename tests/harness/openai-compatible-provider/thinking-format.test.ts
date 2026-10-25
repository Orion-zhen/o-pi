import { describe, expect, it } from "vitest";
import { capturePayload, loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("SDK 原生思考配置", () => {
	it.each([
		["chat-template", "chatTemplateKwargs", "chat_template_kwargs"],
		["baseten", "chatTemplateArgs", "chat_template_args"],
	] as const)("%s 的变量对象整体替换，省略 omitWhenOff 会重新发送 off 开关", async (thinkingFormat, option, field) => {
		const compat = { thinkingFormat, [option]: { enabled: { $var: "thinking.enabled", omitWhenOff: true }, keep: true } };
		const model = { id: "m", reasoning: true };
		const inherited = await loadProvider(temp.path, { compat, models: [model] });
		expect(await capturePayload(inherited)).toHaveProperty(field, { keep: true });
		const override = { compat: { [option]: { enabled: { $var: "thinking.enabled" } } } };
		for (const config of [{ compat, models: [{ ...model, ...override }] }, { compat, models: [model], modelOverrides: { m: override } }]) {
			const fixture = await loadProvider(temp.path, config);
			expect(await capturePayload(fixture)).toHaveProperty(field, { keep: true, enabled: false });
		}
	});

	it("原生思考格式遵循服务、模型和覆盖优先级", async () => {
		const fixture = await loadProvider(temp.path, {
			compat: { thinkingFormat: "qwen-chat-template" },
			models: [
				{ id: "inherited", reasoning: true },
				{ id: "defined", reasoning: true, compat: { thinkingFormat: "deepseek" } },
				{ id: "overridden", reasoning: true, compat: { thinkingFormat: "deepseek" } },
			],
			modelOverrides: { overridden: { compat: { thinkingFormat: "openai" } } },
		});
		expect(await capturePayload(fixture, { reasoning: "high" }, { modelId: "inherited" })).toHaveProperty("chat_template_kwargs.enable_thinking", true);
		expect(await capturePayload(fixture, { reasoning: "high" }, { modelId: "defined" })).toHaveProperty("thinking.type", "enabled");
		const overridden = await capturePayload(fixture, { reasoning: "high" }, { modelId: "overridden" });
		expect(overridden).toHaveProperty("reasoning_effort", "high");
		expect(overridden).not.toHaveProperty("thinking");
	});

	it("未配置格式时由 SDK 检测地址，原生字段可显式覆盖", async () => {
		const fixture = await loadProvider(temp.path, { baseUrl: "https://api.deepseek.com/v1", models: [{ id: "m", reasoning: true }] });
		expect(fixture.harness.providers).toEqual([]);
		expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty("thinking.type", "enabled");
		const explicit = await loadProvider(temp.path, {
			compat: { thinkingFormat: "openai" }, baseUrl: "https://api.deepseek.com/v1", models: [{ id: "m", reasoning: true }],
		});
		const request = await capturePayload(explicit, { reasoning: "high" });
		expect(request).toHaveProperty("reasoning_effort", "high");
		expect(request).not.toHaveProperty("thinking");
	});

	it.each(["openai", "chat-template"])("请求扩展不重写 SDK 原生 %s 配置", async (thinkingFormat) => {
		const config = { compat: { thinkingFormat, chatTemplateKwargs: { enabled: { $var: "thinking.enabled" } },
			chatTemplateArgs: { effort: { $var: "thinking.effort" } } }, models: [{ id: "m", reasoning: true }] };
		const native = await loadProvider(temp.path, config);
		const expected = await capturePayload(native, { reasoning: "high" });
		const extended = await loadProvider(temp.path, { ...config, maxRetries: 0 });
		expect(extended.harness.providers).toHaveLength(1);
		expect(await capturePayload(extended, { reasoning: "high" })).toEqual(expected);
	});

	it.each([
		{ off: undefined, omitWhenOff: false, expected: { enable_thinking: false } },
		{ off: "disabled", omitWhenOff: false, expected: { enable_thinking: false, reasoning_effort: "disabled" } },
		{ off: "disabled", omitWhenOff: true, expected: { enable_thinking: false } },
	])("chat-template 的 off 发送关闭开关，effort 遵循显式映射和省略选项 %#", async ({ off, omitWhenOff, expected }) => {
		const fixture = await loadProvider(temp.path, {
			compat: { thinkingFormat: "chat-template", chatTemplateKwargs: {
				enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort", omitWhenOff }, budget: { $var: "thinking.budget" },
			} },
			models: [{ id: "m", reasoning: true, thinkingLevelMap: { off } }],
		});
		expect(await capturePayload(fixture)).toHaveProperty("chat_template_kwargs", expected);
	});

	it.each([false, true])("Responses 保留原生 reasoning 及等级映射，请求扩展=%s", async (extended) => {
		const fixture = await loadProvider(temp.path, { api: "openai-responses", ...(extended && { maxRetries: 0 }),
			models: [{ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "max" } }] });
		expect(fixture.harness.providers).toHaveLength(extended ? 1 : 0);
		expect(await capturePayload(fixture, { reasoning: "xhigh" })).toMatchObject({ reasoning: { effort: "max" }, include: ["reasoning.encrypted_content"] });
		expect(await capturePayload(fixture)).toHaveProperty("reasoning.effort", "none");
	});

	it.each(["openai-completions", "openai-responses"] as const)("%s 按原样发送模型 ID，等级仅影响原生思考字段", async (api) => {
		const fixture = await loadProvider(temp.path, { api, extraBody: { custom: true }, models: [{ id: "m:low", reasoning: true }] });
		for (const options of [{}, { reasoning: "high" }] as const) {
			const payload = await capturePayload(fixture, options, { modelId: "m:low" });
			expect(payload).toMatchObject({ model: "m:low", custom: true });
			if (options.reasoning) expect(payload).toHaveProperty(api === "openai-completions" ? "reasoning_effort" : "reasoning.effort", "high");
		}
	});
});
