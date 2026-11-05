import { Notification, type BrowserWindow } from "electron";
import type { GuiAttention } from "../gui/shared/protocol/connection.ts";
import type { Attention } from "../harness/attention.ts";
import { notificationContent } from "../gui/shared/notification.ts";

const active = new Set<Notification>();

/** 窗口焦点由主进程读取，订阅建立后重新上报。 */
export function trackDesktopAttention(window: BrowserWindow, report: (value: GuiAttention) => void): () => void {
	const update = () => report({
		focused: window.isFocused() && window.isVisible() && !window.isMinimized(),
		destination: "desktop",
	});
	window.on("focus", update).on("blur", update).on("minimize", update)
		.on("restore", update).on("show", update).on("hide", update);
	return update;
}

export function showDesktopNotification(window: BrowserWindow, event: Attention, icon: string, open: () => void): void {
	if (event.kind === "approval" && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true);
	if (!Notification.isSupported()) return;
	let notification: Notification | undefined;
	try {
		notification = new Notification({ ...notificationContent(event), icon });
		const shown = notification;
		active.add(shown);
		notification.once("close", () => active.delete(shown));
		notification.once("failed", () => active.delete(shown));
		notification.once("click", () => { active.delete(shown); open(); });
		notification.show();
	} catch {
		if (notification) active.delete(notification);
		// 通知权限、签名或系统后端不可用时，不中断会话。
	}
}
