import type { GuiSessionInfo, SessionTarget } from "../contract.ts";
import type { SessionActivity } from "./use-session-activity.ts";

export interface SessionListItem {
	key: string;
	target: SessionTarget;
	path: string | null;
	cwd: string;
	title: string;
	modified: string;
	selected: boolean;
	activity: SessionActivity | undefined;
}

/** 登记只提供身份和活动信息，不表示执行资源已经加载。 */
export function sessionList(history: GuiSessionInfo[], activity: SessionActivity[], selectedId: string | null): SessionListItem[] {
	const rows = new Map<string, SessionListItem>();
	for (const item of history) rows.set(item.path, {
		...item, key: item.path, target: { path: item.path }, selected: false, activity: undefined,
	});
	for (const item of activity) {
		const key = item.path ?? item.sessionId;
		rows.set(key, {
			key, target: { id: item.sessionId }, path: item.path, cwd: item.cwd, title: item.title,
			modified: rows.get(key)?.modified ?? (item.completedAt ? new Date(item.completedAt).toISOString() : ""),
			selected: item.sessionId === selectedId, activity: item,
		});
	}
	return [...rows.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}
