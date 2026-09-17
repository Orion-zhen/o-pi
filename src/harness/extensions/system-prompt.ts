import { type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildAgentSystemPrompt, buildRuntimeSystemPrompt } from "../system-prompt/service.ts";
import { canPresent, type Presenter } from "../presentation.ts";
type SystemPresenter = Presenter<(ctx: ExtensionCommandContext, prompt: string) => Promise<void>>;

const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";

/** Pi 生命周期与 /system TUI composition root。 */
export default function systemPrompt(pi: ExtensionAPI, present?: SystemPresenter): void {
	registerSystemCommand(pi, present);
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
export function registerSystemCommand(pi: Pick<ExtensionAPI, "registerCommand">, present?: SystemPresenter): void {
	pi.registerCommand("system", {
		description: SYSTEM_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (present === undefined || !canPresent(ctx, present)) return;
			const prompt = await buildRuntimeSystemPrompt(ctx.getSystemPromptOptions(), ctx.cwd);
			await present.show(ctx, prompt);
		},
	});
}
