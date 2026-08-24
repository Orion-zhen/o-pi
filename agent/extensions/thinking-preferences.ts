import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ThinkingLevelPreferences } from "../../src/thinking-level/preferences.js";

type ThinkingPreferencesAPI = Pick<
	ExtensionAPI,
	"appendEntry" | "getThinkingLevel" | "on" | "setThinkingLevel"
>;

/** 在会话分支内按模型记忆原生 /thinking 选择。 */
export default function thinkingPreferencesExtension(pi: ThinkingPreferencesAPI): void {
	const preferences = new ThinkingLevelPreferences(pi);
	const restore = (ctx: ExtensionContext): void => {
		preferences.restore(ctx.sessionManager.getBranch(), ctx.model);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("thinking_level_select", (event, ctx) => {
		preferences.selectLevel(event.level, ctx.model);
	});
	pi.on("model_select", (event) => {
		preferences.selectModel(event.model);
	});
}
