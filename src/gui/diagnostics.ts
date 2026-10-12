import type { Static } from "typebox";
import type { guiDiagnosticSchema } from "./diagnostic-schema.ts";

export const diagnosticScopes = {
	messages: "消息区",
	"session-sidebar": "会话信息",
	sidebar: "左侧栏",
	composer: "输入区",
	toolbar: "会话工具栏",
	settings: "设置面板",
	panel: "功能面板",
	dialog: "交互对话框",
	application: "整个界面",
} as const;
export const diagnosticKinds = {
	region: "区域渲染失败",
	"react-root": "整页渲染失败",
	script: "未捕获脚本异常",
	promise: "未处理异步异常",
	startup: "界面加载失败",
	"renderer-exit": "渲染进程退出",
} as const;
export type GuiDiagnostic = Static<typeof guiDiagnosticSchema>;
export interface DiagnosticReceipt { file: string; run: string; environment: string; saved: boolean }

export function errorSummary(message: string): string {
	const line = message.trim().replace(/[\r\n][\s\S]*/, "");
	return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

export function diagnosticText(value: GuiDiagnostic): string {
	const { message, stack, componentStack, ...context } = value;
	return `${diagnosticKinds[value.kind]} / ${diagnosticScopes[value.scope]}\n${JSON.stringify(context, null, 2)}\n${message}\n${stack}\n${componentStack}`;
}
