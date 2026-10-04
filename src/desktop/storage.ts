import { app, session } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StorageEntry, StorageGroup } from "../gui/storage.ts";
import { inspectStorageTree, missingStorage, removeStorageTree, type StorageTree } from "../gui/host/storage/files.ts";
import type { DesktopDiagnostics } from "./diagnostics.ts";

type Target = { kind: "cache" } | { kind: "diagnostics"; tree: StorageTree };

/** Chromium 缓存交给 Electron 清理，不直接删除正在使用的浏览器数据目录。 */
export class DesktopStorage {
	private targets = new Map<string, Target>();
	private pending: Promise<void> = Promise.resolve();
	constructor(private diagnostics: DesktopDiagnostics) {}

	private run<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.pending.then(operation);
		this.pending = task.then(() => {}, () => {});
		return task;
	}
	read(): Promise<StorageGroup> {
		return this.run(async () => {
			const root = app.getPath("sessionData");
			const bytes = await session.defaultSession.getCacheSize();
			const cache: StorageEntry = { id: randomUUID(), name: "浏览器 HTTP 缓存", path: root, bytes, files: null, modified: 0, blocked: null };
			const group: StorageGroup = {
				id: "desktop", title: "Desktop 缓存与日志",
				paths: [root, path.dirname(this.diagnostics.file)], entries: [cache], error: null,
			};
			const targets = new Map<string, Target>([[cache.id, { kind: "cache" }]]);
			for (const file of [this.diagnostics.file, this.diagnostics.archiveFile]) {
				try {
					const tree = await inspectStorageTree(path.dirname(file), file, new AbortController().signal);
					const entry: StorageEntry = {
						id: randomUUID(), name: path.basename(file), path: file, bytes: tree.bytes, files: tree.files, modified: tree.modified,
						blocked: file === this.diagnostics.file ? "正在记录 GUI 诊断" : tree.blocked,
					};
					group.entries.push(entry);
					if (!entry.blocked) targets.set(entry.id, { kind: "diagnostics", tree });
				} catch (error) {
					if (!missingStorage(error)) group.error = error instanceof Error ? error.message : String(error);
				}
			}
			this.targets = targets;
			return group;
		});
	}
	clear(value: unknown): Promise<void> {
		return this.run(async () => {
			if (!Array.isArray(value) || !value.length || value.length > 2 || value.some((id) => typeof id !== "string") || new Set(value).size !== value.length)
				throw new Error("无效 Desktop 存储条目。");
			const targets = value.map((id: string) => {
				const target = this.targets.get(id);
				if (!target) throw new Error("Desktop 存储列表已更新，请刷新。");
				return { id, target };
			});
			for (const { id, target } of targets) {
				if (target.kind === "cache") await session.defaultSession.clearCache();
				else await this.diagnostics.manageFiles(async () => {
					const tree = await inspectStorageTree(target.tree.root, target.tree.file, new AbortController().signal);
					if (tree.canonicalRoot !== target.tree.canonicalRoot || tree.version !== target.tree.version) throw new Error("诊断日志已轮转，请刷新后重新确认。");
					removeStorageTree(tree);
				});
				this.targets.delete(id);
			}
		});
	}
}
