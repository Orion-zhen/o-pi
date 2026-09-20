import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoTitleConfig } from "./config.ts";

export async function generateTitle(
	config: AutoTitleConfig,
	text: string,
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	signal: AbortSignal,
): Promise<string> {
	let model: Model<Api> | undefined = ctx.model;
	if (config.model !== null) {
		const separator = config.model.indexOf("/");
		model = ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1));
	}
	if (!model) throw new Error("Auto-title model is unavailable.");
	signal.throwIfAborted();
	const reasoning = getSupportedThinkingLevels(model)[0];
	const response = await ctx.modelRegistry.streamSimple(
		model,
		{
			systemPrompt: config.system_prompt,
			messages: [{ role: "user", content: truncate(text.trim(), 2000), timestamp: Date.now() }],
		},
		{
			signal,
			...(reasoning === undefined || reasoning === "off" ? {} : { reasoning }),
			maxTokens: 1024,
			maxRetries: 0,
		},
	).result();
	signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Auto-title request ${response.stopReason}.`);
	}
	const title = response.content.filter((part) => part.type === "text").map((part) => part.text).join("")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "")
		.replace(/\s+/gu, " ").trim();
	if (!title) throw new Error("Auto-title returned an empty title.");
	return truncate(title, 50);
}

function truncate(text: string, limit: number): string {
	let result = "";
	let count = 0;
	for (const character of text) {
		if (count++ === limit) break;
		result += character;
	}
	return result;
}
