import type { Attention } from "../../../harness/attention.ts";
import { notificationContent } from "../../shared/notification.ts";

export const NOTIFICATION_PERMISSION_CHANGED = "opi:notification-permission";

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
	return window.isSecureContext && "Notification" in window ? Notification.permission : "unsupported";
}

export function notificationDestination(): string | null {
	if (browserNotificationPermission() !== "granted") return null;
	let id = localStorage.getItem("opi.notification-destination");
	if (!id) { id = crypto.randomUUID(); localStorage.setItem("opi.notification-destination", id); }
	return `web:${id}`;
}

export async function requestNotificationPermission(): Promise<void> {
	await Notification.requestPermission();
	window.dispatchEvent(new Event(NOTIFICATION_PERMISSION_CHANGED));
}

export function showBrowserNotification(event: Attention, open: () => void): void {
	if (browserNotificationPermission() !== "granted") return;
	const { title, body, silent } = notificationContent(event);
	try {
		const notification = new Notification(title, { body, silent, tag: `${event.sessionId}:${event.kind}` });
		notification.onclick = () => { notification.close(); window.focus(); open(); };
	} catch {
		// 浏览器或系统可拒绝通知，不影响会话和审批。
	}
}
