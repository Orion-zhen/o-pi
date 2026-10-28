import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { OpenAICompletionsCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import type { ConfigObject } from "./document.ts";
import { configuredModels, type ModelSettings } from "./model-settings.ts";
import { thinkingCapabilities } from "./thinking-capabilities.ts";

export const THINKING_FORMATS = OpenAICompletionsCompatSchema.properties.thinkingFormat.anyOf.map(({ const: format }) => format);

// SDK 未导出兼容默认值解析器。只镜像设置所需字段，并用实际请求测试校验。
function detectedServiceCompat(provider: string, baseUrl: string, modelId?: string):
	Pick<Required<OpenAICompletionsCompat>, "thinkingFormat" | "maxTokensField" | "supportsStore" | "supportsReasoningEffort">
	& Pick<OpenAICompletionsCompat, "supportsDeveloperRole"> {
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
	const supportsDeveloperRole = openrouter ? modelId === undefined ? undefined : modelId.startsWith("anthropic/") || modelId.startsWith("openai/") : !nonStandard;
	return {
		thinkingFormat: deepseek ? "deepseek" : zai ? "zai" : together ? "together" : antLing ? "ant-ling" : openrouter ? "openrouter" : "openai",
		maxTokensField: chutes || deepseek || moonshot || gateway || together || nvidia || antLing || zai ? "max_tokens" : "max_completion_tokens",
		...(supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole }),
		supportsStore: !nonStandard,
		supportsReasoningEffort: !grok && !zai && !moonshot && !together && !gateway && !nvidia && !antLing,
	};
}

export type ServiceCompatSettings = ReturnType<typeof serviceCompatSettings>;

export const MERGED_COMPAT_FIELDS = ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const;

/** 这些嵌套字段按键继承，其余值整体替换，与 SDK 合并模型配置的规则一致。 */
function mergeServiceCompat(base: OpenAICompletionsCompat, override: OpenAICompletionsCompat = {}): OpenAICompletionsCompat {
	const compat = { ...base, ...override };
	for (const key of MERGED_COMPAT_FIELDS) {
		const inherited = base[key];
		const own = override[key];
		if (inherited && own) Object.assign(compat, { [key]: { ...inherited, ...own } });
	}
	return compat;
}

export function serviceCompatSettings(providerId: string, provider: ConfigObject, model?: Pick<ModelSettings, "id" | "defaults" | "configured">) {
	const configuredApi = model?.configured.api ?? model?.defaults?.api ?? provider.api;
	const api = configuredApi === "openai-completions" || configuredApi === "openai-responses" ? configuredApi : undefined;
	const baseUrl = model?.configured.baseUrl ?? model?.defaults?.baseUrl ?? provider.baseUrl;
	const address = typeof baseUrl === "string" ? baseUrl : "";
	let defaults: OpenAICompletionsCompat = model && model.defaults === undefined ? {} : api === "openai-completions"
		? detectedServiceCompat(providerId, address, model?.id)
		: api === "openai-responses" ? { supportsDeveloperRole: true, supportsReasoningEffort: false } : {};
	if (!model && api === "openai-completions" && defaults.supportsDeveloperRole === undefined) {
		const values = configuredModels(provider).map(({ id }) => detectedServiceCompat(providerId, address, id).supportsDeveloperRole);
		const first = values[0];
		if (first !== undefined && values.every((value) => value === first)) defaults.supportsDeveloperRole = first;
	}
	if (model) {
		for (const layer of [provider, model.defaults]) {
			defaults = mergeServiceCompat(defaults, layer?.compat as OpenAICompletionsCompat | undefined);
		}
	}
	const configured = model ? model.configured : provider;
	const own = (configured.compat as OpenAICompletionsCompat | undefined) ?? {};
	const effective = mergeServiceCompat(defaults, own);
	const completions = api === "openai-completions";
	const templateKey: "chatTemplateKwargs" | "chatTemplateArgs" | undefined = !completions ? undefined : effective.thinkingFormat === "chat-template" ? "chatTemplateKwargs"
		: effective.thinkingFormat === "baseten" ? "chatTemplateArgs" : undefined;
	const capabilities = api === undefined ? undefined : thinkingCapabilities(api, providerId, effective);
	return { api, own, defaults, templateKey, capabilities };
}
