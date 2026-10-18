import type { Attention } from "../harness/attention.ts";

export function notificationContent(event: Attention): { title: string; body: string; silent: boolean } {
	const text = (event.name?.trim() || event.firstMessage).replace(/\s+/gu, " ").trim() || "新会话";
	const characters = [...text];
	const label = characters.slice(0, 80).join("") + (characters.length > 80 ? "…" : "");
	return {
		title: event.kind === "approval" ? "OPi 需要审批" : "OPi 任务完成",
		body: event.kind === "approval" ? `${label}\n${event.toolName} 请求执行权限` : label,
		silent: event.kind === "completed",
	};
}
