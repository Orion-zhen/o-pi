import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UsageRequestError, type UsageResetOutcome, type UsageSnapshot } from "../../../harness/usage/types.ts";
import { UsageHttpError } from "../../../harness/usage/request.ts";
import type { GuiAction, GuiUsageResetResult } from "../../shared/protocol/actions.ts";
import type { GuiExecution } from "./execution.ts";

type ViewAction = Extract<GuiAction, { action: "view" }>;

function viewContext(host: GuiExecution, signal: AbortSignal): ExtensionCommandContext {
	const context = host.runtime.session.extensionRunner.createCommandContext();
	const sessionSignal = context.signal;
	// 保留 SDK 上下文的惰性 getter 和失效检查。
	Object.defineProperty(context, "signal", {
		value: sessionSignal ? AbortSignal.any([sessionSignal, signal]) : signal,
	});
	return context;
}

export async function openView(host: GuiExecution, action: ViewAction, signal: AbortSignal): Promise<void> {
	const command = host.runtime.session.extensionRunner.getCommand(action.view);
	if (!command) throw new Error(`视图不可用: ${action.view}`);
	await command.handler(action.view === "usage" && action.refresh ? "refresh" : "", viewContext(host, signal));
}

export async function consumeUsageCredit(host: GuiExecution, action: Extract<GuiAction, { action: "consumeCodexCredit" }>, signal: AbortSignal): Promise<GuiUsageResetResult> {
	const context = viewContext(host, signal);
	let resetOutcome: UsageResetOutcome;
	try {
		resetOutcome = await host.usageService.consumeCodexCredit(context, { ...action, signal: context.signal });
	} catch (error) {
		throw new Error(resetFailure(error));
	}
	let value: UsageSnapshot;
	try {
		value = await host.usageService.load(context, { refresh: true, signal: context.signal });
	} catch (error) {
		if (!(error instanceof UsageRequestError) || error.code !== "aborted") throw error;
		return { outcome: resetOutcome, refreshed: false };
	}
	host.emit({ type: "panel", panel: { kind: "usage", value } });
	return { outcome: resetOutcome, refreshed: true };
}

function resetFailure(error: unknown): string {
	if (error instanceof UsageHttpError) return `重置请求返回 HTTP ${error.status}。请刷新用量后重试同一张卡。`;
	if (error instanceof UsageRequestError) {
		if (error.code === "auth") return "Codex 认证失败，请重新登录。";
		if (error.code === "busy") return "已有重置请求正在处理，请稍后再试。";
	}
	return "未能确认重置结果，卡片可能已使用。请刷新用量，或重试同一张卡以确认结果。";
}
