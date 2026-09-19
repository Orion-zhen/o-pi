import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { GuiEvent, GuiSessionActivity } from "../contract.ts";
import type { GuiConfigDocument } from "../preferences.ts";
import { ApprovalStores, SessionApprovalRules } from "../../harness/approval/rules/store.ts";
import { lspManager } from "../../harness/lsp/index.ts";
import { GuiSession } from "./session.ts";
import { GuiSessionCatalog } from "./sessions.ts";
import { GuiClient } from "./client.ts";
import { prepareSessionDeletion } from "./delete-session.ts";
import { modelScope } from "./models.ts";
import { readGuiConfig, readGuiDefaults } from "./preferences.ts";

export interface SessionSlot {
	id: string;
	cwd: string;
	file: string | null;
	manager: SessionManager | undefined;
	instance: GuiSession | undefined;
	pending: Promise<GuiSession> | undefined;
	closing: Promise<void> | undefined;
	rules: SessionApprovalRules;
	users: Set<GuiClient>;
	holds: number;
	removing: boolean;
	lastUsed: number;
	wasRunning: boolean;
	activity: GuiSessionActivity;
	scopedModels: string[] | undefined;
	stamp: string | undefined;
	startEvent: SessionStartEvent;
}

/** 宿主持有实例与索引，客户端只持有独立的查看位置。 */
export class GuiHost {
	readonly slots = new Map<string, SessionSlot>();
	readonly clients = new Set<GuiClient>();
	readonly approvals = new ApprovalStores();
	private projectTrust = new Map<string, boolean>();
	readonly catalog = new GuiSessionCatalog((value, workspaces) => {
		this.emit({ type: "sessions", value }); this.emit({ type: "workspaces", value: workspaces });
	}, () => [this.workspaceRoot, ...[...this.slots.values()].filter((slot) => slot.users.size || slot.instance?.running).map((slot) => slot.cwd)]);
	workspaceRoot = "";
	initial: SessionSlot | undefined;
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
		const slot = sessionId ? this.slots.get(sessionId) : this.initial;
		if (slot) void client.select(slot).catch((error: unknown) => client.reportError(error));
		return client;
	}

	async start(cwd: string): Promise<void> {
		if (this.closed) throw new Error("宿主已关闭。");
		this.applyGuiConfig(await readGuiConfig());
		this.workspaceRoot = path.resolve(cwd);
		this.emit({ type: "workspaceRoot", path: this.workspaceRoot });
		const slot = await this.newSlot(this.workspaceRoot, { type: "session_start", reason: "startup" });
		this.initial = slot;
		for (const client of this.clients) if (!client.selected) void client.select(slot).catch((error: unknown) => client.reportError(error));
		await this.ensure(slot);
		this.refresh();
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

	track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		return task.finally(() => this.tasks.delete(task));
	}

	emit(event: GuiEvent): void { for (const listener of this.listeners) listener(event); }
	reportError(error: unknown): void { this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
	subscribe(listener: (event: GuiEvent) => void): () => void {
		this.listeners.add(listener);
		if (this.workspaceRoot) listener({ type: "workspaceRoot", path: this.workspaceRoot });
		if (this.catalog.value) listener({ type: "sessions", value: this.catalog.value });
		if (this.catalog.workspaces) listener({ type: "workspaces", value: this.catalog.workspaces });
		listener({ type: "activity", value: [...this.slots.values()].map((slot) => slot.activity) });
		return () => this.listeners.delete(listener);
	}
	refresh(): void {
		if (this.closed || this.refreshPending) return;
		this.refreshPending = true;
		queueMicrotask(() => {
			this.refreshPending = false;
			void this.catalog.refresh().catch((error: unknown) => { if (!this.closed) this.reportError(error); });
		});
	}
	private activityChanged(): void {
		if (this.closed || this.activityPending) return;
		this.activityPending = true;
		queueMicrotask(() => {
			this.activityPending = false;
			if (!this.closed) this.emit({ type: "activity", value: [...this.slots.values()].map((slot) => slot.activity) });
		});
	}
	private renamed(slot: SessionSlot, title: string): void {
		slot.activity = { ...slot.activity, title };
		this.activityChanged();
	}

	private changed(slot: SessionSlot): void {
		const instance = slot.instance;
		const running = instance?.running ?? false;
		const completedAt = slot.wasRunning && !running ? Math.max(Date.now(), slot.activity.completedAt + 1) : slot.activity.completedAt;
		slot.wasRunning = running;
		const next: GuiSessionActivity = {
			sessionId: slot.id, path: slot.file, cwd: slot.cwd,
			title: instance?.ready ? instance.runtime.session.sessionName || "新会话" : slot.activity.title,
			state: instance?.dialogs.list().length ? "waiting" : slot.pending ? "loading" : running ? "running" : "idle",
			completedAt,
		};
		if (JSON.stringify(next) !== JSON.stringify(slot.activity)) { slot.activity = next; this.activityChanged(); }
		this.scheduleCollection();
	}

	register(manager: SessionManager, startEvent: SessionStartEvent = { type: "session_start", reason: "resume" }): SessionSlot {
		if (this.closed) throw new Error("宿主已关闭。");
		const id = manager.getSessionId();
		const file = manager.getSessionFile() ?? null;
		const existing = this.slots.get(id);
		if (existing) {
			if (existing.file !== file) throw new Error("会话标识重复，请导入为新会话。");
			return existing;
		}
		const cwd = manager.getCwd();
		const slot: SessionSlot = {
			id, cwd, file, manager, instance: undefined, pending: undefined, closing: undefined,
			rules: new SessionApprovalRules(), users: new Set(), holds: 0, removing: false, lastUsed: Date.now(), wasRunning: false,
			activity: { sessionId: id, path: file, cwd, title: manager.getSessionName() || "新会话", state: "idle", completedAt: 0 },
			scopedModels: undefined, stamp: undefined, startEvent,
		};
		slot.stamp = this.fileStamp(slot);
		this.slots.set(id, slot);
		this.activityChanged();
		return slot;
	}
	async newSlot(cwd: string, event: SessionStartEvent = { type: "session_start", reason: "new" }): Promise<SessionSlot> {
		cwd = path.resolve(cwd);
		if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
		return this.register(SessionManager.create(cwd), event);
	}
	async openFile(file: string): Promise<SessionSlot> {
		file = path.resolve(file);
		if (this.deleting.has(file)) throw new Error("会话正在删除。");
		if (!(await stat(file)).isFile()) throw new Error("会话路径不是文件。");
		const existing = [...this.slots.values()].find((slot) => slot.file === file);
		if (existing) { await this.refreshCached(existing); return existing; }
		const manager = SessionManager.open(file);
		if (!(await stat(manager.getCwd())).isDirectory()) throw new Error("工作目录不是文件夹。");
		return this.register(manager);
	}

	refreshCached(slot: SessionSlot): Promise<void> | undefined {
		if (!slot.users.size && slot.instance?.canRelease && slot.stamp !== this.fileStamp(slot)) return this.release(slot);
		return undefined;
	}

	async ensure(slot: SessionSlot, client?: GuiClient): Promise<GuiSession> {
		if (this.closed || slot.removing || this.slots.get(slot.id) !== slot) throw new Error("会话已关闭或正在删除。");
		slot.lastUsed = Date.now();
		if (slot.closing) await slot.closing;
		if (this.closed || slot.removing || this.slots.get(slot.id) !== slot) throw new Error("会话已关闭或正在删除。");
		if (slot.pending) return slot.pending;
		if (slot.instance) return slot.instance;
		const instance = new GuiSession(slot.id, () => this.changed(slot), () => this.refresh());
		slot.instance = instance;
		for (const user of slot.users) user.bind(instance);
		const initialize = async () => {
			let manager = slot.manager;
			if (!manager) {
				if (!slot.file || !(await stat(slot.file)).isFile()) throw new Error("会话记录不存在。");
				manager = SessionManager.open(slot.file);
				if (manager.getSessionId() !== slot.id) throw new Error("会话文件已被替换，请刷新列表。");
			}
			if (this.closed || slot.removing || this.slots.get(slot.id) !== slot) throw new Error("会话已关闭或正在删除。");
			await instance.start(manager, { stores: this.approvals, rules: slot.rules, trust: this.projectTrust }, client?.forSession(slot), { event: slot.startEvent, models: slot.scopedModels });
			slot.startEvent = { type: "session_start", reason: "resume" };
			return instance;
		};
		const pending = initialize().catch(async (error: unknown) => {
			// start 的任务已结算后再释放，避免启动任务等待自身。
			slot.instance = undefined;
			await instance.dispose();
			throw error;
		}).finally(() => { slot.pending = undefined; this.changed(slot); });
		slot.pending = pending;
		this.changed(slot);
		return pending;
	}

	private fileStamp(slot: SessionSlot): string | undefined {
		if (!slot.file || !existsSync(slot.file)) return undefined;
		const metadata = statSync(slot.file);
		return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
	}
	captureFile(slot: SessionSlot): void {
		if (slot.instance?.canRelease) slot.stamp = this.fileStamp(slot) ?? slot.stamp;
	}

	async use<T>(slot: SessionSlot, client: GuiClient, operation: (session: GuiSession) => Promise<T>): Promise<T> {
		slot.holds++;
		try { return await operation(await this.ensure(slot, client)); }
		finally { slot.holds--; slot.lastUsed = Date.now(); this.captureFile(slot); this.scheduleCollection(); }
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
		const idle = [...this.slots.values()].filter((slot) => slot.lastUsed <= cutoff
			&& !slot.users.size && !slot.holds && !slot.pending && !slot.closing && slot.instance?.canRelease)
			.sort((a, b) => b.lastUsed - a.lastUsed);
		for (const slot of idle.slice(this.cache.idleLimit)) {
			// 释放其他实例期间，候选会话可能被重新使用。
			if (slot.lastUsed <= cutoff) await this.release(slot);
		}
		if ([...this.slots.values()].some((slot) => slot.instance && !slot.users.size)) this.scheduleCollection();
	}
	private async release(slot: SessionSlot): Promise<void> {
		const instance = slot.instance;
		if (!instance || slot.users.size || slot.holds || slot.pending || slot.closing || !instance.canRelease) return;
		slot.scopedModels = modelScope(instance.runtime);
		const manager = instance.runtime.session.sessionManager;
		slot.closing = instance.dispose().then(() => {
			slot.manager = slot.stamp !== undefined || slot.file && existsSync(slot.file) ? undefined : manager;
			slot.instance = undefined;
		}).finally(() => { slot.closing = undefined; });
		await slot.closing;
	}

	private changeHistory<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.historyMutation.then(operation);
		this.historyMutation = pending.then(() => {}, () => {});
		return pending;
	}

	rename(file: string, name: string, client: GuiClient): Promise<void> {
		return this.changeHistory(async () => {
			const target = [...this.slots.values()].find((slot) => slot.file === file);
			if (target?.instance) await this.use(target, client, (instance) => instance.dispatch({ action: "rename", name }, client.forSession(target)));
			else {
				if (target?.manager && target.stamp === undefined && !existsSync(file)) target.manager.appendSessionInfo(name);
				else { await this.catalog.rename(file, name); if (target) target.manager = undefined; }
				if (target) this.renamed(target, name);
			}
			await this.catalog.refresh();
		});
	}

	remove(files: string[]): Promise<void> { return this.changeHistory(() => this.removeFiles(files)); }

	private async removeFiles(files: string[]): Promise<void> {
		const normalized = files.map((file) => path.resolve(file));
		const affected = [...this.slots.values()].filter((slot) => slot.file && normalized.includes(slot.file));
		if (affected.some((slot) => slot.holds || slot.pending || slot.closing || slot.instance && !slot.instance.canRelease))
			throw new Error("请先停止或等待对应会话的操作结束。");
		for (const file of normalized) this.deleting.add(file);
		for (const slot of affected) slot.removing = true;
		try {
			for (const slot of affected) {
				if (!slot.instance || !slot.users.size) continue;
				const before = await slot.instance.runtime.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
				if (before?.cancel) return;
			}
			const plan = await prepareSessionDeletion(normalized, new Set(affected.flatMap((slot) => slot.file ? [slot.file] : [])), () => this.catalog.paths());
			await plan.verify();
			for (const slot of affected) {
				const instance = slot.instance;
				if (!instance) continue;
				const manager = instance.runtime.session.sessionManager;
				slot.scopedModels = modelScope(instance.runtime);
				await instance.dispose();
				slot.manager = slot.stamp !== undefined || slot.file && existsSync(slot.file) ? undefined : manager;
				slot.instance = undefined;
			}
			await plan.remove();
			for (const slot of affected) {
				this.slots.delete(slot.id);
				const users = [...this.clients].filter((client) => client.selected === slot);
				if (users.length || this.initial === slot) {
					const next = await this.newSlot(slot.cwd);
					if (this.initial === slot) this.initial = next;
					await Promise.all(users.map((user) => user.select(next)));
				}
			}
			this.activityChanged();
		} finally {
			for (const file of normalized) this.deleting.delete(file);
			for (const slot of affected) slot.removing = false;
			await this.catalog.refresh();
		}
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.timer);
		for (const client of [...this.clients]) client.close();
		await Promise.all([...this.slots.values()].map(async (slot) => {
			await slot.instance?.dispose();
			await slot.closing;
			if (slot.pending) await Promise.allSettled([slot.pending]);
		}));
		await Promise.allSettled([...this.tasks]);
		await this.catalog.dispose();
		await lspManager.reload();
		this.slots.clear(); this.listeners.clear();
	}
}
