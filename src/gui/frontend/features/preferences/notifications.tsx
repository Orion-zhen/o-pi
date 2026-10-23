import { useEffect, useState } from "react";
import { browserNotificationPermission, NOTIFICATION_PERMISSION_CHANGED, requestNotificationPermission } from "@/connection/notifications.ts";
import { Button } from "@/ui/button.tsx";
import { SettingsSection } from "@/forms/settings-controls.tsx";

export function NotificationSettings() {
	const [permission, setPermission] = useState(browserNotificationPermission);
	const [error, setError] = useState("");
	useEffect(() => {
		const update = () => setPermission(browserNotificationPermission());
		window.addEventListener("focus", update);
		window.addEventListener(NOTIFICATION_PERMISSION_CHANGED, update);
		return () => { window.removeEventListener("focus", update); window.removeEventListener(NOTIFICATION_PERMISSION_CHANGED, update); };
	}, []);
	if (window.opi) return null;
	return <SettingsSection title="系统通知">
		<p>后台会话需要审批或任务完成时提醒。未命名会话会展示首条消息摘要。</p>
		{permission === "default" ? <Button onClick={() => { void requestNotificationPermission().catch((error: unknown) => setError(String(error))); }}>允许浏览器通知</Button>
			: <p>{permission === "granted" ? "已允许通知" : permission === "denied" ? "通知已被拒绝，请在浏览器网站设置中修改。" : "当前浏览器不支持通知，或页面不是安全上下文。"}</p>}
		{error && <p role="alert">{error}</p>}
	</SettingsSection>;
}
