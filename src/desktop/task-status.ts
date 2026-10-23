import { app, nativeImage, type BrowserWindow, type NativeImage } from "electron";
import type { GuiSessionActivity } from "../gui/shared/protocol/state.ts";

/** 原生状态不依赖渲染帧确认，窗口最小化时仍及时更新。 */
export class DesktopTaskStatus {
	private activities: GuiSessionActivity[] = [];
	private seen = new Map<string, number>();
	private count = 0;
	private readonly overlay: NativeImage | undefined;
	constructor(private readonly window: BrowserWindow, icon: string) {
		this.overlay = process.platform === "win32" ? nativeImage.createFromPath(icon) : undefined;
	}

	update(activities: GuiSessionActivity[]): boolean {
		this.activities = activities;
		const ids = new Set(activities.map((item) => item.sessionId));
		for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
		this.render();
		return activities.some((item) => item.state === "running" || item.state === "loading");
	}
	markRead(sessionId: unknown, completedAt: unknown): void {
		if (typeof sessionId !== "string" || typeof completedAt !== "number" || !Number.isSafeInteger(completedAt) || completedAt < 0)
			throw new Error("无效已读记录");
		const item = this.activities.find((item) => item.sessionId === sessionId);
		if (!item) return;
		this.seen.set(sessionId, Math.max(this.seen.get(sessionId) ?? 0, Math.min(item.completedAt, completedAt)));
		this.render();
	}
	clear(): void { this.update([]); }
	private render(): void {
		const count = this.activities.filter((item) => item.state === "waiting" || item.completedAt > (this.seen.get(item.sessionId) ?? 0)).length;
		if (count !== this.count) {
			this.count = count;
			if (process.platform === "darwin") app.dock?.setBadge(count ? String(count) : "");
			else if (process.platform === "win32" && this.overlay) this.window.setOverlayIcon(count ? this.overlay : null, count ? `${count} 个会话待处理或未读` : "");
			else app.setBadgeCount(count);
		}
	}
}
