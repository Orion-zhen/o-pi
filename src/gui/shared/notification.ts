import type { Attention } from "../../harness/attention.ts";

export function notificationContent(event: Attention): { title: string; body: string; silent: boolean } {
	return {
		title: event.kind === "approval" ? "等待审批" : "任务已完成",
		body: event.kind === "approval" ? "有操作需要你的许可。" : "后台会话已完成本轮任务。",
		silent: event.kind === "completed",
	};
}
