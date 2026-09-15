import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiSessionInfo } from "../contract.ts";

/** 会话索引独立于流式快照，合并并发读取并保留读取期间发生的刷新请求。 */
export class GuiSessionCatalog {
	value: GuiSessionInfo[] | undefined;
	private pending: Promise<void> | undefined;
	private dirty = false;
	private closed = false;

	constructor(private publish: (sessions: GuiSessionInfo[]) => void) {}

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
			if (this.closed) return;
			this.value = sessions.map(({ path, cwd, name, firstMessage, modified }) => ({
				path,
				cwd,
				title: name || firstMessage.replace(/\s+/g, " ").slice(0, 160),
				modified: modified.toISOString(),
			}));
			this.publish(this.value);
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		if (this.pending) await Promise.allSettled([this.pending]);
	}
}
