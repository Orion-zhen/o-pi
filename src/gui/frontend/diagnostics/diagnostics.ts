import { diagnosticText, type GuiDiagnostic } from "../../shared/diagnostics/diagnostics.ts";
import { showDiagnostic } from "./panel.ts";

let sequence = 0;
const pageId = Date.now().toString(36);
const context: Pick<GuiDiagnostic, "sessionId" | "lastAction" | "lastEvent" | "deliveryId" | "running"> = {
	sessionId: null, lastAction: null, lastEvent: null, deliveryId: null, running: null,
};

/** 只保留身份与阶段，不保存操作参数或会话正文。 */
export function diagnosticContext(value: Partial<typeof context>): void { Object.assign(context, value); }

function describeError(error: unknown): { message: string; stack: string } {
	if (error instanceof Error) return { message: `${error.name}: ${error.message}`.slice(0, 4096), stack: (error.stack ?? "").slice(0, 16384) };
	return { message: (typeof error === "string" ? error : `非 Error 异常 (${error === null ? "null" : typeof error})`).slice(0, 4096), stack: "" };
}

export function reportDiagnostic(kind: GuiDiagnostic["kind"], scope: GuiDiagnostic["scope"], error: unknown, componentStack?: string | null): GuiDiagnostic {
	const value: GuiDiagnostic = {
		id: `${pageId}-${++sequence}`, at: Date.now(), kind, scope, ...describeError(error),
		componentStack: (componentStack ?? "").slice(0, 8192), ...context, userAgent: navigator.userAgent.slice(0, 1024),
	};
	console.error(diagnosticText(value));
	const update = showDiagnostic(value);
	const desktop = window.opi;
	if (desktop) {
		void desktop.reportDiagnostic(value).then((receipt) => update(
			receipt.saved ? "诊断已写入日志。" : "诊断日志写入失败，请复制保留。",
			`${receipt.saved ? "已写入" : "写入失败"}: ${receipt.file}\nrun: ${receipt.run}\n${receipt.environment}`,
		), (error: unknown) => update("诊断日志写入失败，请复制保留。", `诊断日志写入失败: ${describeError(error).message}`));
	} else update("Web 端未保存到服务器，请复制诊断信息。");
	return value;
}

export function installGlobalDiagnostics(): void {
	const script = (event: ErrorEvent) => {
		// 布局通知未在本帧送完，不等同于脚本抛错。保留浏览器默认控制台输出。
		if (event.message === "ResizeObserver loop completed with undelivered notifications."
			&& event.error == null && event.lineno === 0 && event.colno === 0) return;
		reportDiagnostic("script", "application", event.error ?? `${event.message}\n${event.filename}:${event.lineno}:${event.colno}`);
	};
	const promise = (event: PromiseRejectionEvent) => { reportDiagnostic("promise", "application", event.reason); };
	window.addEventListener("error", script);
	window.addEventListener("unhandledrejection", promise);
}
