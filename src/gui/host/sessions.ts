import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listWorkspaces } from "./workspaces.ts";
import type { GuiSessionInfo, GuiWorkspaceInfo } from "../contract.ts";
import { inspectHistoryFile } from "./history-file.ts";

export async function renameSavedSession(path: string, name: string): Promise<void> {
	const item = (await SessionManager.listAll()).find((item) => item.path === path);
	if (!item) throw new Error("历史记录已不存在，请刷新列表。");
	await inspectHistoryFile(item.path);
	SessionManager.open(item.path).appendSessionInfo(name);
}

/** 会话索引独立于流式快照，合并并发读取并保留读取期间发生的刷新请求。 */
export class GuiSessionCatalog {
	value: GuiSessionInfo[] | undefined;
	workspaces: GuiWorkspaceInfo[] | undefined;
	private pending: Promise<void> | undefined;
	private dirty = false;
	private closed = false;

	constructor(
		private publish: (sessions: GuiSessionInfo[], workspaces: GuiWorkspaceInfo[]) => void,
		private protectedPaths: () => string[],
	) {}

	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.dirty = true;
		this.pending ??= this.load().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	private async load(): Promise<void> {
		while (this.dirty && !this.closed) {
			this.dirty = false;
			// 不传目录才能遍历共享 sessions 下的各工作区。
			const sessions = await SessionManager.listAll();
			const workspaces = await listWorkspaces(sessions.map((session) => session.cwd), this.protectedPaths());
			if (this.closed) return;
			this.workspaces = workspaces;
			this.value = sessions.map(({ path, cwd, name, firstMessage, modified }) => ({
				path,
				cwd,
				title: name || firstMessage.replace(/\s+/g, " ").slice(0, 160),
				modified: modified.toISOString(),
			}));
			this.publish(this.value, workspaces);
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		if (this.pending) await Promise.allSettled([this.pending]);
	}
}
