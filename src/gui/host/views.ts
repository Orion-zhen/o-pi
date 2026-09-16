import type { GuiAction } from "../contract.ts";
import type { GuiHost } from "./host.ts";

type View = Extract<GuiAction, { action: "view" }>["view"];

export async function openView(host: GuiHost, view: View, signal: AbortSignal): Promise<void> {
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
