import type { Api, Model } from "@earendil-works/pi-ai";
import { configObject } from "./document.ts";
import { modelOptions, type ProviderConfig } from "./schema.ts";

/** 返回改写后的会话请求体。未改写时沿用 SDK 原值。 */
export function applyRequestOptions(payload: unknown, model: Pick<Model<Api>, "id" | "api">, provider: ProviderConfig): unknown {
	const options = modelOptions(provider, model.id);
	const drop = [...(provider.dropParams ?? []), ...(options.dropParams ?? [])];
	// OpenAI 允许不发送输出上限。其他 API 保留 SDK 的预算处理。
	if ((model.api === "openai-completions" || model.api === "openai-responses") && options.maxTokens === undefined) {
		drop.push("max_tokens", "max_completion_tokens", "max_output_tokens");
	}
	if (!provider.extraBody && !drop.length) return undefined;
	if (!configObject(payload)) throw new Error(`API ${model.api}: extraBody/dropParams require an object payload`);
	const result = { ...payload, ...provider.extraBody };
	for (const key of drop) delete result[key];
	return result;
}
