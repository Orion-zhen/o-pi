import { useCallback, useMemo, useState } from "react";
import type { GuiSessionActivity } from "../contract.ts";

export type SessionActivity = GuiSessionActivity & { unread: boolean };
export type ActivityState = "running" | "waiting" | "unread" | "idle";

export function workspaceActivity(items: SessionActivity[], cwd: string): ActivityState {
	const sessions = items.filter((item) => item.cwd === cwd);
	if (sessions.some((item) => item.state === "waiting")) return "waiting";
	if (sessions.some((item) => item.state === "running" || item.state === "loading")) return "running";
	return sessions.some((item) => item.unread) ? "unread" : "idle";
}

function readSeen(): Record<string, number> {
	const value: unknown = JSON.parse(sessionStorage.getItem("opi.read") ?? "{}");
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("已读记录无效。");
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

export function useSessionActivity(items: GuiSessionActivity[], reportError: (message: string) => void) {
	const [seen, setSeen] = useState<Record<string, number>>(() => {
		try { return readSeen(); }
		catch { return {}; }
	});
	const markRead = useCallback((sessionId: string, completedAt: number) => {
		if (!completedAt) return;
		setSeen((current) => {
			if ((current[sessionId] ?? 0) >= completedAt) return current;
			const next = { ...current, [sessionId]: completedAt };
			try { sessionStorage.setItem("opi.read", JSON.stringify(next)); }
			catch (error) { queueMicrotask(() => reportError(`已读记录保存失败: ${String(error)}`)); }
			return next;
		});
	}, [reportError]);
	const activity = useMemo(() => items.map((item): SessionActivity => ({ ...item, unread: item.completedAt > (seen[item.sessionId] ?? 0) })), [items, seen]);
	return { activity, markRead };
}
