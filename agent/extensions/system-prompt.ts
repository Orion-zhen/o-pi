import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildAgentSystemPrompt,
	buildRuntimeSystemPrompt,
} from "../../src/system-prompt/service.js";
import type { TokenCounterScope } from "../../src/token-counter.js";

const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";

/** Pi 生命周期与 /system TUI composition root。 */
export default function systemPrompt(pi: ExtensionAPI): void {
	registerSystemCommand(pi);
	pi.on("before_agent_start", async (event, ctx) => {
		const systemPrompt = await buildAgentSystemPrompt({
			options: event.systemPromptOptions,
			cwd: ctx.cwd,
			activeTools: pi.getActiveTools(),
		});
		return { systemPrompt };
	});
}

/** 注册 /system 命令，用只读浮层查看当前 system prompt；内容不会写入会话历史。 */
export function registerSystemCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("system", {
		description: SYSTEM_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return;
			const prompt = await buildRuntimeSystemPrompt(ctx.getSystemPromptOptions(), ctx.cwd);
			const { SystemPromptViewer } = await import("../../src/system-prompt/tui/viewer.js");
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new SystemPromptViewer(
					prompt,
					theme,
					() => tui.terminal.rows,
					done,
					tokenScopeFromModel(ctx.model),
				),
			);
		},
	});
}

function tokenScopeFromModel(model: { provider?: string; id?: string; baseUrl?: string } | undefined): TokenCounterScope {
	return {
		...(model?.provider !== undefined ? { provider: model.provider } : {}),
		...(model?.id !== undefined ? { modelId: model.id } : {}),
		...(model?.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
	};
}
