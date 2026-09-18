import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listWorkspaces } from "./workspaces.ts";
import type { GuiSessionInfo, GuiWorkspaceInfo } from "../contract.ts";
import { inspectHistoryFile } from "./history-file.ts";
import { GuiSessionIndex } from "./session-index.ts";

/** 会话索引独立于流式快照，合并并发读取并保留读取期间发生的刷新请求。 */
export class GuiSessionCatalog {
	value: GuiSessionInfo[] | undefined;
	workspaces: GuiWorkspaceInfo[] | undefined;
	private pending: Promise<void> | undefined;
	private dirty = false;
	private closed = false;
	private index = new GuiSessionIndex();

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

	async paths(): Promise<Set<string>> {
		await this.refresh();
		return new Set(this.value?.map((session) => session.path));
	}

	async rename(path: string, name: string): Promise<void> {
		if (!(await this.paths()).has(path)) throw new Error("历史记录已不存在，请刷新列表。");
		await inspectHistoryFile(path);
		SessionManager.open(path).appendSessionInfo(name);
	}

	private async load(): Promise<void> {
		while (this.dirty && !this.closed) {
			this.dirty = false;
			const sessions = await this.index.list();
			const workspaces = await listWorkspaces(sessions.map((session) => session.cwd), this.protectedPaths());
			if (this.closed) return;
			if (this.value?.length === sessions.length && sessions.every((session, index) => session === this.value?.[index])
				&& this.workspaces?.length === workspaces.length && workspaces.every((workspace, index) => workspace.path === this.workspaces?.[index]?.path && workspace.exists === this.workspaces?.[index]?.exists)) continue;
			this.workspaces = workspaces;
			this.value = sessions;
			this.publish(this.value, workspaces);
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		if (this.pending) await Promise.allSettled([this.pending]);
	}
}
