import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildRuntimeSystemPrompt } from "./service.ts";

/** 运行中使用 SDK 的请求投影，空闲时从当前分支重放已持久化的指令。 */
export async function readCurrentSystemPrompt(ctx: Pick<ExtensionCommandContext, "cwd" | "isIdle" | "getSystemPrompt" | "getSystemPromptOptions" | "sessionManager">): Promise<string> {
	if (!ctx.isIdle()) return ctx.getSystemPrompt();
	const options = ctx.getSystemPromptOptions();
	if (process.env.PI_SUBAGENT_FORK !== "1") {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		if (messages.some((message) => message.role === "system")) return getCurrentSystemPrompt(messages);
	}
	return buildRuntimeSystemPrompt(options, ctx.cwd, options.selectedTools?.includes("subagent") ?? false);
}
