import { useCallback, useMemo, useRef, useState } from "react";
import type { GuiSessionActivity } from "../../../shared/protocol/state.ts";

export type SessionActivity = GuiSessionActivity & { unread: boolean };
export type ActivityState = "running" | "waiting" | "unread" | "idle";

const priority: Record<ActivityState, number> = { idle: 0, unread: 1, running: 2, waiting: 3 };

export function workspaceActivities(items: SessionActivity[]): Map<string, ActivityState> {
	const states = new Map<string, ActivityState>();
	for (const item of items) {
		const state = item.state === "waiting" ? "waiting"
			: item.state === "running" || item.state === "loading" ? "running" : item.unread ? "unread" : "idle";
		const previous = states.get(item.cwd);
		if (previous === undefined || priority[state] > priority[previous]) states.set(item.cwd, state);
	}
	return states;
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
	const seenRef = useRef(seen);
	const saveSeen = useCallback((next: Record<string, number>) => {
		seenRef.current = next;
		setSeen(next);
		try { sessionStorage.setItem("opi.read", JSON.stringify(next)); }
		catch (error) { reportError(`已读记录保存失败: ${String(error)}`); }
	}, [reportError]);
	const markRead = useCallback((sessionId: string, completedAt: number) => {
		if (!completedAt || (seenRef.current[sessionId] ?? 0) >= completedAt) return;
		saveSeen({ ...seenRef.current, [sessionId]: completedAt });
		window.opi?.markRead(sessionId, completedAt);
	}, [saveSeen]);
	const activity = useMemo(() => items.map((item): SessionActivity => ({ ...item, unread: item.completedAt > (seen[item.sessionId] ?? 0) })), [items, seen]);
	const forget = useCallback((ids: string[]) => {
		const removed = new Set(ids);
		saveSeen(Object.fromEntries(Object.entries(seenRef.current).filter(([id]) => !removed.has(id))));
	}, [saveSeen]);
	return { activity, markRead, forget };
}
