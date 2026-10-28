import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyRequestOptions } from "./payload.ts";
import { modelOptions, type ModelsConfig } from "./schema.ts";

/** 只订阅原生事件，不注册或替换 provider。 */
export function registerModelServices(pi: ExtensionAPI, config: ModelsConfig): void {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const provider = config.providers[model.provider];
		if (provider) return applyRequestOptions(event.payload, model, provider);
	});
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const provider = config.providers[event.model.provider];
		if (!provider) return;
		const level = modelOptions(provider, event.model.id).defaultThinkingLevel;
		if (level !== undefined) pi.setThinkingLevel(level);
	});
}
