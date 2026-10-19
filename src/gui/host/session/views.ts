import type { GuiAction } from "../../contract.ts";
import type { GuiExecution } from "./execution.ts";

type ViewAction = Extract<GuiAction, { action: "view" }>;

export async function openView(host: GuiExecution, action: ViewAction, signal: AbortSignal): Promise<void> {
	const { view } = action;
	const runner = host.runtime.session.extensionRunner;
	const command = runner.getCommand(view);
	if (!command) throw new Error(`视图不可用: ${view}`);
	const context = runner.createCommandContext();
	const sessionSignal = context.signal;
	// 保留 SDK 上下文的惰性 getter 和失效检查。
	Object.defineProperty(context, "signal", {
		value: sessionSignal ? AbortSignal.any([sessionSignal, signal]) : signal,
	});
	await command.handler(action.view === "usage" && action.refresh ? "refresh" : "", context);
}
