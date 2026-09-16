import type { GuiAction } from "../contract.ts";
import type { GuiHost } from "./host.ts";

type View = Extract<GuiAction, { action: "view" }>["view"];

export async function openView(host: GuiHost, view: View, signal: AbortSignal): Promise<void> {
	const panel = (title: string, value: unknown = null) => host.emit({ type: "panel", title, value });
	switch (view) {
		case "model": return panel("模型");
		case "settings": return panel("设置");
		case "auth": return panel("认证");
		case "help": return panel("命令帮助", host.snapshot().commands);
		case "import": return panel("导入会话");
		default: {
			const runner = host.runtime.session.extensionRunner;
			const command = runner.getCommand(view);
			if (!command) throw new Error(`视图不可用: ${view}`);
			const context = runner.createCommandContext();
			const sessionSignal = context.signal;
			// 保留 SDK 上下文的惰性 getter 和失效检查。
			Object.defineProperty(context, "signal", {
				value: sessionSignal ? AbortSignal.any([sessionSignal, signal]) : signal,
			});
			await command.handler("", context);
		}
	}
}
