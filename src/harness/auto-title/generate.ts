import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoTitleConfig } from "./config.ts";

export async function generateTitle(
	config: AutoTitleConfig,
	messages: readonly AgentMessage[],
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	signal: AbortSignal,
): Promise<string> {
	const transcript: string[] = [];
	for (const message of messages.toReversed()) {
		if (transcript.length === config.max_messages) break;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = (typeof message.content === "string" ? message.content : message.content
			.filter((part) => part.type === "text").map((part) => part.text).join("\n")).trim();
		if (text) transcript.push(`${message.role === "user" ? "User" : "Assistant"}:\n${truncate(text, 2000)}`);
	}
	if (!transcript.length) throw new Error("Auto-title requires user or assistant text.");
	let model: Model<Api> | undefined = ctx.model;
	if (config.model !== null) {
		model = ctx.modelRegistry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === config.model);
	}
	if (!model) throw new Error("Auto-title model is unavailable.");
	signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	signal.throwIfAborted();
	const reasoning = clampThinkingLevel(model, config.thinking_level);
	const response = await ctx.modelRegistry.streamSimple(
		model,
		{
			systemPrompt: config.system_prompt,
			messages: [{ role: "user", content: `<transcript>\n${transcript.reverse().join("\n\n")}\n</transcript>`, timestamp: Date.now() }],
		},
		{
			signal,
			...(reasoning === "off" ? {} : { reasoning }),
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
