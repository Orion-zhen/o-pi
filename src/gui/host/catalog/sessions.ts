import path from "node:path";
import { listWorkspaces } from "./workspaces.ts";
import type { GuiSessionInfo, GuiWorkspaceInfo } from "../../shared/protocol/state.ts";
import { readSessionIndex } from "./session-index.ts";
import { watchSessionDirectory } from "./session-watch.ts";

interface CatalogOptions {
	publish: (sessions: GuiSessionInfo[], workspaces: GuiWorkspaceInfo[], invalidated: string[] | null) => void;
	protectedWorkspaces: () => string[];
	scope: () => readonly string[] | undefined;
	reportError: (error: unknown) => void;
}

/** 合并自动刷新，保留读取期间的变更。已发布状态只供 UI 重放，不作为磁盘查询来源。 */
export class GuiSessionCatalog {
	value: GuiSessionInfo[] | undefined;
	workspaces: GuiWorkspaceInfo[] | undefined;
	private pending: Promise<void> | undefined;
	private dirty = false;
	private changedDirectories: Set<string> | null = new Set();
	private closed = false;
	private unwatch: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private options: CatalogOptions) {}

	watch(): void {
		this.unwatch = watchSessionDirectory((directory) => this.schedule(directory), this.options.reportError);
	}

	/** 无参数只更新列表范围。目录变更使对应工作区搜索失效，null 表示整个历史目录。 */
	schedule(directory?: string | null): void {
		if (this.closed) return;
		this.dirty = true;
		if (directory === null) this.changedDirectories = null;
		else if (directory !== undefined) this.changedDirectories?.add(directory);
		if (this.pending || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush().catch(this.options.reportError);
		}, 100);
	}

	/** 显式刷新立即读取，并使正文搜索失效。 */
	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = true;
		this.changedDirectories = null;
		return this.flush();
	}

	private flush(): Promise<void> { return this.pending ??= this.load(); }

	private async load(): Promise<void> {
		try {
			while (this.dirty && !this.closed) {
				this.dirty = false;
				const changed = this.changedDirectories;
				this.changedDirectories = new Set();
				const { sessions, files } = await readSessionIndex(this.options.scope());
				const workspaces = await listWorkspaces(files.map((file) => file.cwd), this.options.protectedWorkspaces());
				if (this.closed) return;
				// 删除和替换也要通知旧工作区，不保存额外的文件索引。
				const invalidated = changed === null ? null : [...new Set([...(this.value ?? []), ...files]
					.filter((file) => changed.has(path.dirname(file.path))).map((file) => file.cwd))];
				this.workspaces = workspaces;
				this.value = sessions;
				this.options.publish(sessions, workspaces, invalidated);
			}
		} finally { this.pending = undefined; }
	}

	async dispose(): Promise<void> {
		this.closed = true;
		this.unwatch?.();
		clearTimeout(this.timer);
		if (this.pending) await Promise.allSettled([this.pending]);
	}
}
