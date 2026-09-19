import path from "node:path";
import { stat } from "node:fs/promises";
import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { GuiEvent, WorkspaceQuery } from "../contract.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import { ApprovalStores } from "../../harness/approval/rules/store.ts";
import { lspManager } from "../../harness/lsp/index.ts";
import { GuiSession } from "./session.ts";
import { GuiSessionCatalog } from "./sessions.ts";
import { GuiClient } from "./client.ts";
import { prepareSessionDeletion } from "./delete-session.ts";
import { listWorkspaceFiles, previewWorkspaceFile } from "./workspace-files.ts";
import { readWorkspaceGit } from "./workspace-git.ts";
import type { WorkspaceGit } from "../workbench.ts";
import { readGuiConfig, readGuiDefaults } from "./preferences.ts";

/** 共享服务与会话目录。执行资源的准入和收尾由逻辑会话管理。 */
export class GuiHost {
	readonly sessions = new Map<string, GuiSession>();
	readonly clients = new Set<GuiClient>();
	private approvals = new ApprovalStores();
	private projectTrust = new Map<string, boolean>();
	private workbenchController = new AbortController();
	private pendingGit = new Map<string, Promise<WorkspaceGit | null>>();
	readonly catalog = new GuiSessionCatalog((value, workspaces) => {
		this.emit({ type: "sessions", value }); this.emit({ type: "workspaces", value: workspaces });
	}, () => [this.workspaceRoot, ...[...this.sessions.values()].filter((session) => session.observed || session.activity.state !== "idle").map((session) => session.cwd)]);
	workspaceRoot = "";
	initial: GuiSession | undefined;
	private listeners = new Set<(event: GuiEvent) => void>();
	private tasks = new Set<Promise<unknown>>();
	private historyMutation: Promise<void> = Promise.resolve();
	private closed = false;
	private refreshPending = false;
	private activityPending = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private deleting = new Set<string>();
	private cache = readGuiDefaults().sessionCache;

	createClient(sessionId?: string): GuiClient {
		if (this.closed) throw new Error("宿主已关闭。");
		const client = new GuiClient(this);
		this.clients.add(client);
		const session = sessionId ? this.sessions.get(sessionId) : this.initial;
		if (session) void client.select(session).catch((error: unknown) => client.reportError(error));
		return client;
	}
	async start(cwd: string): Promise<void> {
		if (this.closed) throw new Error("宿主已关闭。");
		this.workspaceRoot = path.resolve(cwd);
		this.emit({ type: "workspaceRoot", path: this.workspaceRoot });
		this.applyGuiConfig(await readGuiConfig());
		const session = await this.newSession(this.workspaceRoot, { type: "session_start", reason: "startup" });
		this.initial = session;
		for (const client of this.clients) if (!client.selected) void client.select(session).catch((error: unknown) => client.reportError(error));
		await session.ensure();
		this.refresh();
		this.refreshModelCatalog(session);
	}
	/** 启动时给 initial 会话补一次联网刷新，不阻塞启动；关闭或超时即取消，失败只落 notice。 */
	private refreshModelCatalog(session: GuiSession): void {
		if (this.closed || process.env.PI_OFFLINE !== undefined) return;
		const execution = session.execution;
		if (!execution) return;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		timeout.unref();
		this.track(
			execution
				.refreshModelCatalog(AbortSignal.any([controller.signal, this.workbenchController.signal]))
				.finally(() => clearTimeout(timeout)),
		);
	}
	applyGuiConfig(document: GuiConfigDocument): void {
		if (document.state === "ready") {
			const cache = document.value.sessionCache;
			if (cache.idleLimit !== this.cache.idleLimit || cache.idleMs !== this.cache.idleMs) {
				this.cache = cache;
				const scheduled = this.timer !== undefined;
				clearTimeout(this.timer);
				this.timer = undefined;
				if (scheduled) this.scheduleCollection();
			}
		}
		this.emit({ type: "guiConfig", value: document });
	}
	async queryWorkspace(query: WorkspaceQuery) {
		const signal = this.workbenchController.signal;
		const git = () => {
			let pending = this.pendingGit.get(query.cwd);
			if (!pending) {
				pending = readWorkspaceGit(query.cwd, signal).finally(() => this.pendingGit.delete(query.cwd));
				this.pendingGit.set(query.cwd, pending);
			}
			return pending;
		};
		const result = query.query === "workspaceFiles" ? await listWorkspaceFiles(query.cwd, query.path)
			: query.query === "workspaceGit" ? await git()
			: await previewWorkspaceFile(query.cwd, query.path, signal, git);
		signal.throwIfAborted();
		return result;
	}
	track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		return task.finally(() => this.tasks.delete(task));
	}
	emit(event: GuiEvent): void { for (const listener of this.listeners) listener(event); }
	reportError(error: unknown): void { this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
	subscribe(listener: (event: GuiEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	replay(listener: (event: GuiEvent) => void): void {
		if (this.workspaceRoot) listener({ type: "workspaceRoot", path: this.workspaceRoot });
		if (this.catalog.value) listener({ type: "sessions", value: this.catalog.value });
		if (this.catalog.workspaces) listener({ type: "workspaces", value: this.catalog.workspaces });
		listener({ type: "activity", value: this.activity });
	}
	refresh(): void {
		if (this.closed || this.refreshPending) return;
		this.refreshPending = true;
		queueMicrotask(() => {
			this.refreshPending = false;
			void this.catalog.refresh().catch((error: unknown) => { if (!this.closed) this.reportError(error); });
		});
	}
	private get activity() {
		return [...this.sessions.values()].filter((session) => !session.pending).map((session) => session.activity);
	}
	private activityChanged(): void {
		if (this.closed || this.activityPending) return;
		this.activityPending = true;
		queueMicrotask(() => {
			this.activityPending = false;
			if (!this.closed) this.emit({ type: "activity", value: this.activity });
		});
	}
	register(manager: SessionManager, event: SessionStartEvent = { type: "session_start", reason: "resume" }): GuiSession {
		if (this.closed) throw new Error("宿主已关闭。");
		const existing = this.sessions.get(manager.getSessionId());
		if (existing) {
			if (existing.file !== (manager.getSessionFile() ?? null)) throw new Error("会话标识重复，请导入为新会话。");
			return existing;
		}
		const session = new GuiSession(manager, { stores: this.approvals, trust: this.projectTrust }, event,
			(changed) => { if (changed) this.activityChanged(); this.scheduleCollection(); }, () => this.refresh());
		this.sessions.set(session.id, session);
		this.activityChanged();
		return session;
	}
	async newSession(cwd: string, event: SessionStartEvent = { type: "session_start", reason: "new" }): Promise<GuiSession> {
		cwd = path.resolve(cwd);
		if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
		return this.register(SessionManager.create(cwd), event);
	}
	async openFile(file: string): Promise<GuiSession> {
		file = path.resolve(file);
		if (this.deleting.has(file)) throw new Error("会话正在删除。");
		const existing = [...this.sessions.values()].find((session) => session.file === file);
		if (existing) return existing;
		if (!(await stat(file)).isFile()) throw new Error("会话路径不是文件。");
		const manager = SessionManager.open(file);
		if (!(await stat(manager.getCwd())).isDirectory()) throw new Error("工作目录不是文件夹。");
		return this.register(manager);
	}
	scheduleCollection(): void {
		if (this.closed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.collect().catch((error: unknown) => this.reportError(error));
		}, this.cache.idleMs);
		this.timer.unref();
	}
	async collect(): Promise<void> {
		const cutoff = Date.now() - this.cache.idleMs;
		const idle = [...this.sessions.values()].filter((session) => session.lastUsed <= cutoff && session.canRelease)
			.sort((a, b) => b.lastUsed - a.lastUsed);
		for (const session of idle.slice(this.cache.idleLimit)) {
			// 等待其他会话释放后，候选会话可能已经重新使用。
			if (session.lastUsed <= cutoff) await session.release();
		}
		if ([...this.sessions.values()].some((session) => session.needsCollection)) this.scheduleCollection();
	}
	private changeHistory<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.historyMutation.then(operation);
		this.historyMutation = pending.then(() => {}, () => {});
		return pending;
	}
	rename(file: string, name: string, client: GuiClient): Promise<void> {
		return this.changeHistory(async () => {
			const target = [...this.sessions.values()].find((session) => session.file === file);
			const rename = () => this.catalog.rename(file, name);
			if (target) await target.rename(name, client.forSession(target), rename);
			else await rename();
			await this.catalog.refresh();
		});
	}
	remove(files: string[]): Promise<void> { return this.changeHistory(() => this.removeFiles(files)); }
	private async removeFiles(files: string[]): Promise<void> {
		const normalized = [...new Set(files.map((file) => path.resolve(file)))];
		const affected = [...this.sessions.values()].filter((session) => session.file && normalized.includes(session.file));
		try {
			for (const session of affected) session.reserveDeletion();
			for (const file of normalized) this.deleting.add(file);
			for (const session of affected) if (!await session.confirmDeletion()) return;
			const plan = await prepareSessionDeletion(normalized, new Set(affected.flatMap((session) => session.file ? [session.file] : [])), () => this.catalog.paths());
			await plan.verify();
			for (const session of affected) await session.prepareDeletion();
			const removed = new Set<string>();
			try { await plan.remove((file) => removed.add(file)); }
			finally {
				const deleted = affected.filter((session) => session.file && removed.has(session.file));
				for (const session of deleted) { session.deleted(); this.sessions.delete(session.id); }
				if (removed.size) this.emit({ type: "sessionsDeleted", ids: deleted.map((session) => session.id), paths: [...removed] });
				this.activityChanged();
				for (const session of deleted) {
					const viewers = [...this.clients].filter((client) => client.selected === session);
					const initial = this.initial === session;
					if (initial) this.initial = undefined;
					if (viewers.length || initial) {
						const next = await this.newSession(session.cwd);
						if (initial) this.initial = next;
						await Promise.all(viewers.map((client) => client.select(next)));
					}
				}
			}
		} finally {
			for (const file of normalized) this.deleting.delete(file);
			for (const session of affected) session.cancelDeletion();
			await this.catalog.refresh();
		}
	}
	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.workbenchController.abort();
		clearTimeout(this.timer);
		for (const client of [...this.clients]) client.close();
		const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
		await Promise.allSettled([...this.tasks]);
		results.push(...await Promise.allSettled([this.catalog.dispose(), lspManager.reload()]));
		this.sessions.clear(); this.listeners.clear();
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length) throw new AggregateError(errors, "宿主资源释放失败。");
	}
}
