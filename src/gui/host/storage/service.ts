import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageEntry, StorageGroup, StorageSnapshot, StorageSourceId } from "../../storage.ts";
import { storagePathInUse } from "../../../harness/storage/active.ts";
import { withHistoryLock } from "../../../harness/user-history.ts";
import type { GuiHost } from "../host.ts";
import { inspectStorageTree, missingStorage, removeStorageTree, within, type StorageTree } from "./files.ts";
import { storageSources } from "./sources.ts";

interface StoredEntry { entry: StorageEntry; tree: StorageTree; group: StorageSourceId }
const DAY = 24 * 60 * 60 * 1000;

/** 每个客户端只保留最近一次扫描的授权，不接受界面传入任意文件路径。 */
export class GuiStorage {
	private entries = new Map<string, StoredEntry>();
	private controller = new AbortController();
	constructor(private host: GuiHost) {}

	private blocked(group: StorageSourceId, tree: StorageTree): string | null {
		if (tree.blocked) return tree.blocked;
		if (storagePathInUse(tree.file)) return "正在使用";
		if (group === "sessions" && [...this.host.sessions.values()].some((session) => session.file === tree.file && (session.execution || session.observed)))
			return "会话已打开，切换后等待执行资源释放";
		const resources = process.env.PI_OPI_RESOURCE_DIR;
		if (group === "resources" && resources && within(tree.file, path.resolve(resources))) return "当前程序正在使用";
		if (group === "temporary" && Date.now() - tree.modified < DAY) return "保留最近 24 小时的临时文件";
		if (group === "logs" && path.basename(tree.file) === "mcp.log") return "当前 MCP 日志";
		return null;
	}

	async read(): Promise<StorageSnapshot> {
		const next = new Map<string, StoredEntry>();
		const groups: StorageGroup[] = [];
		const signal = this.controller.signal;
		for (const source of storageSources(this.host)) {
			signal.throwIfAborted();
			const group: StorageGroup = { id: source.id, title: source.title, paths: source.paths, entries: [], error: null };
			groups.push(group);
			try {
				const candidates = await source.candidates();
				if (candidates.length > 50_000) throw new Error("条目超过 50000 个，请在文件管理器中处理。");
				for (const candidate of candidates) {
					try {
						const tree = await inspectStorageTree(candidate.root, candidate.file, signal);
						const entry: StorageEntry = {
							id: randomUUID(), name: candidate.name, path: tree.file, bytes: tree.bytes, files: tree.files,
							modified: tree.modified, blocked: this.blocked(source.id, tree),
						};
						group.entries.push(entry);
						next.set(entry.id, { entry, tree, group: source.id });
					} catch (error) {
						signal.throwIfAborted();
						if (!missingStorage(error)) group.error = `部分条目未能统计：${error instanceof Error ? error.message : String(error)}`;
					}
				}
				group.entries.sort((a, b) => b.bytes - a.bytes || b.modified - a.modified || a.path.localeCompare(b.path));
			} catch (error) {
				signal.throwIfAborted();
				group.error = error instanceof Error ? error.message : String(error);
			}
		}
		signal.throwIfAborted();
		this.entries = next;
		return { groups };
	}

	private async verify(record: StoredEntry): Promise<StorageTree> {
		const latest = await inspectStorageTree(record.tree.root, record.tree.file, this.controller.signal);
		if (latest.canonicalRoot !== record.tree.canonicalRoot || latest.version !== record.tree.version)
			throw new Error("条目已变化，请刷新后重新确认。");
		const blocked = this.blocked(record.group, latest);
		if (blocked) throw new Error(blocked);
		return latest;
	}

	async remove(ids: string[]): Promise<void> {
		this.controller.signal.throwIfAborted();
		if ([...this.host.sessions.values()].some((session) => session.activity.state !== "idle")) throw new Error("请先等待所有会话任务结束，再清理存储。");
		const records = ids.map((id) => {
			const record = this.entries.get(id);
			if (!record) throw new Error("存储列表已更新，请刷新后重新选择。");
			if (record.entry.blocked) throw new Error(record.entry.blocked);
			return record;
		});
		for (const record of records) await this.verify(record);
		const sessions = records.filter((record) => record.group === "sessions");
		if (sessions.length) {
			await this.host.remove(sessions.map((record) => record.tree.file), async () => {
				for (const record of sessions) await this.verify(record);
			});
			for (const record of sessions) this.entries.delete(record.entry.id);
		}
		for (const record of records.filter((record) => record.group !== "sessions")) {
			const remove = async () => {
				const tree = await this.verify(record);
				if ([...this.host.sessions.values()].some((session) => session.activity.state !== "idle")) throw new Error("会话任务已开始，清理已停止。");
				removeStorageTree(tree);
			};
			if (record.group === "input") await withHistoryLock(record.tree.file, remove);
			else await remove();
			this.entries.delete(record.entry.id);
		}
	}

	dispose(): void { this.controller.abort(); this.entries.clear(); }
}
