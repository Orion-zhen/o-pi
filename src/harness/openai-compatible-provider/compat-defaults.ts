import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { configObject, type ConfigObject } from "./document.ts";
import { configuredModels, type ModelSettings } from "./model-settings.ts";

// SDK 未导出兼容默认值解析器。只镜像设置所需字段，并用实际请求测试校验。
export function detectedServiceCompat(provider: string, baseUrl: string, modelId?: string):
	Pick<Required<OpenAICompletionsCompat>, "thinkingFormat" | "maxTokensField" | "supportsStore" | "supportsReasoningEffort">
	& { supportsDeveloperRole: boolean | undefined } {
	const zai = provider === "zai" || provider === "zai-coding-cn" || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
	const together = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const moonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const openrouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const workers = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const gateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const nvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const antLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const cerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const deepseek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
	const grok = provider === "xai" || baseUrl.includes("api.x.ai");
	const chutes = baseUrl.includes("chutes.ai");
	const nonStandard = nvidia || cerebras || grok || together || chutes || deepseek || zai || moonshot
		|| provider === "opencode" || baseUrl.includes("opencode.ai") || workers || gateway || antLing;
	return {
		thinkingFormat: deepseek ? "deepseek" : zai ? "zai" : together ? "together" : antLing ? "ant-ling" : openrouter ? "openrouter" : "openai",
		maxTokensField: chutes || deepseek || moonshot || gateway || together || nvidia || antLing || zai ? "max_tokens" : "max_completion_tokens",
		supportsDeveloperRole: openrouter ? modelId === undefined ? undefined : modelId.startsWith("anthropic/") || modelId.startsWith("openai/") : !nonStandard,
		supportsStore: !nonStandard,
		supportsReasoningEffort: !grok && !zai && !moonshot && !together && !gateway && !nvidia && !antLing,
	};
}

export type ServiceCompatDefaults = ReturnType<typeof serviceCompatDefaults>;

export function serviceCompatDefaults(providerId: string, provider: ConfigObject, model?: Pick<ModelSettings, "id" | "defaults" | "configured">) {
	const api = model?.configured.api ?? model?.defaults.api ?? provider.api;
	const baseUrl = model?.configured.baseUrl ?? model?.defaults.baseUrl ?? provider.baseUrl;
	const address = typeof baseUrl === "string" ? baseUrl : "";
	const detected = api === "openai-completions"
		? detectedServiceCompat(providerId, address, model?.id)
		: { supportsDeveloperRole: true };
	const compat: ConfigObject = { ...detected };
	if (!model && api === "openai-completions" && detected.supportsDeveloperRole === undefined) {
		const values = configuredModels(provider).map(({ id }) => detectedServiceCompat(providerId, address, id).supportsDeveloperRole);
		compat.supportsDeveloperRole = values.every((value) => value === values[0]) ? values[0] : undefined;
	}
	if (model) {
		for (const layer of [provider, model.defaults]) {
			if (configObject(layer.compat)) Object.assign(compat, layer.compat);
		}
	}
	return {
		api,
		compat,
		thinkingPreset: (model ? model.defaults.thinkingPreset ?? provider.thinkingPreset : undefined)
			?? "auto",
	};
}
