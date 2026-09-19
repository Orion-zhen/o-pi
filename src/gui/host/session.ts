import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { GuiEvent, GuiSessionActivity } from "../contract.ts";
import type { ApprovalStores, SessionApprovalRules } from "../../harness/approval/rules/store.ts";
import { GuiExecution, type SessionClient } from "./execution.ts";
import { modelScope } from "./models.ts";

type Listener = (event: GuiEvent) => void;
type Resources =
	| { state: "unloaded" }
	| { state: "starting"; execution: GuiExecution; task: Promise<GuiExecution> }
	| { state: "ready"; execution: GuiExecution }
	| { state: "closing"; task: Promise<void> };

/** 逻辑会话长期登记，执行资源可回收。所有占用和准入条件集中在此。 */
export class GuiSession {
	readonly id: string;
	readonly cwd: string;
	readonly file: string | null;
	private manager: SessionManager | undefined;
	private resources: Resources = { state: "unloaded" };
	private rules: SessionApprovalRules = { rules: [] };
	private listeners = new Set<Listener>();
	private holds = 0;
	private closed = false;
	private deleting = false;
	private used = Date.now();
	private wasRunning = false;
	private summary: GuiSessionActivity;
	private scopedModels: string[] | undefined;
	private stamp: string | undefined;

	constructor(manager: SessionManager,
		private permissions: { stores: ApprovalStores; trust: Map<string, boolean> },
		private startEvent: SessionStartEvent,
		private notify: (activityChanged: boolean) => void,
		private refreshHistory: () => void,
	) {
		this.manager = manager;
		this.id = manager.getSessionId();
		this.cwd = manager.getCwd();
		this.file = manager.getSessionFile() ?? null;
		this.stamp = this.fileStamp();
		this.summary = { sessionId: this.id, path: this.file, cwd: this.cwd, title: manager.getSessionName() || "新会话", state: "idle", completedAt: 0 };
	}

	get execution(): GuiExecution | undefined {
		return this.resources.state === "starting" || this.resources.state === "ready" ? this.resources.execution : undefined;
	}
	get activity(): GuiSessionActivity { return this.summary; }
	get lastUsed(): number { return this.used; }
	get observed(): boolean { return this.listeners.size > 0; }
	get removing(): boolean { return this.deleting; }
	get canRelease(): boolean {
		return !this.closed && !this.deleting && !this.observed && !this.holds
			&& this.resources.state === "ready" && this.resources.execution.canRelease;
	}
	get needsCollection(): boolean { return this.resources.state === "ready" && !this.observed; }

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		this.execution?.observe(true);
		this.touch();
		return () => {
			this.listeners.delete(listener);
			if (!this.observed) this.execution?.observe(false);
			this.captureFile();
			this.touch();
		};
	}
	replay(listener: Listener): void {
		if (this.execution) this.execution.replay(listener);
		else listener({ type: "snapshot", value: null });
	}
	private touch(): void { this.used = Date.now(); this.notify(false); }
	private changed(): void {
		const execution = this.execution;
		const running = execution?.running ?? false;
		const completedAt = this.wasRunning && !running ? Math.max(Date.now(), this.summary.completedAt + 1) : this.summary.completedAt;
		this.wasRunning = running;
		const title = execution?.ready ? execution.runtime.session.sessionName || "新会话" : this.summary.title;
		const state = execution?.dialogs.list().length ? "waiting" : this.resources.state === "starting" ? "loading" : running ? "running" : "idle";
		if (title !== this.summary.title || state !== this.summary.state || completedAt !== this.summary.completedAt) {
			this.summary = { ...this.summary, title, state, completedAt };
			this.notify(true);
		}
	}

	async ensure(client?: SessionClient): Promise<GuiExecution> {
		this.assertOpen();
		this.touch();
		if (this.resources.state === "closing") await this.resources.task;
		this.assertOpen();
		if (this.resources.state === "starting") return this.resources.task;
		if (this.resources.state === "ready") return this.resources.execution;
		const execution = new GuiExecution(this.id, (event) => {
			for (const listener of this.listeners) listener(event);
		}, () => this.changed(), this.refreshHistory);
		execution.observe(this.observed);
		const initialize = async () => {
			let manager = this.manager;
			if (!manager) {
				if (!this.file || !(await stat(this.file)).isFile()) throw new Error("会话记录不存在。");
				manager = SessionManager.open(this.file);
				if (manager.getSessionId() !== this.id) throw new Error("会话文件已被替换，请刷新列表。");
			}
			this.assertOpen();
			await execution.start(manager, { ...this.permissions, rules: this.rules }, client, { event: this.startEvent, models: this.scopedModels });
			// 退出中的启动正常结算，但不重新挂载正在释放的资源。
			if (!this.closed) {
				this.resources = { state: "ready", execution };
				this.startEvent = { type: "session_start", reason: "resume" };
				this.changed();
			}
			return execution;
		};
		const task = initialize().catch(async (error: unknown) => {
			// 退出已在收尾时，不让失败的启动再等待自己的关闭任务。
			if (this.resources.state === "starting") await this.finish();
			throw error;
		});
		this.resources = { state: "starting", execution, task };
		this.changed();
		return task;
	}
	private assertOpen(): void {
		if (this.closed || this.deleting) throw new Error("会话已关闭或正在删除。");
	}
	async use<T>(client: SessionClient, operation: (execution: GuiExecution) => Promise<T>): Promise<T> {
		this.holds++;
		try { return await operation(await this.ensure(client)); }
		finally { this.holds--; this.captureFile(); this.touch(); }
	}
	private fileStamp(): string | undefined {
		if (!this.file || !existsSync(this.file)) return undefined;
		const value = statSync(this.file);
		return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
	}
	private captureFile(): void {
		if (this.execution?.canRelease) this.stamp = this.fileStamp() ?? this.stamp;
	}
	refreshCached(): Promise<void> | undefined {
		if (this.canRelease && this.stamp !== this.fileStamp()) return this.finish();
	}
	release(): Promise<void> {
		return this.canRelease ? this.finish() : Promise.resolve();
	}

	async rename(name: string, client: SessionClient, renameFile: () => Promise<void>): Promise<void> {
		this.assertOpen();
		if (this.resources.state !== "unloaded") await this.use(client, (execution) => execution.dispatch({ action: "rename", name }, client));
		else {
			if (this.manager && this.stamp === undefined && this.file && !existsSync(this.file)) this.manager.appendSessionInfo(name);
			else { await renameFile(); this.manager = undefined; }
			this.summary = { ...this.summary, title: name };
			this.notify(true);
		}
	}
	reserveDeletion(): void {
		this.assertOpen();
		if (this.holds || this.resources.state !== "unloaded" && (this.resources.state !== "ready" || !this.resources.execution.canRelease))
			throw new Error("请先停止或等待对应会话的操作结束。");
		this.deleting = true;
	}
	cancelDeletion(): void { this.deleting = false; }
	async confirmDeletion(): Promise<boolean> {
		if (!this.observed || !this.execution) return true;
		const result = await this.execution.runtime.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
		return !result?.cancel;
	}
	prepareDeletion(): Promise<void> { return this.finish(); }
	deleted(): void { this.closed = true; }
	close(): Promise<void> {
		this.closed = true;
		return this.finish();
	}

	/** 准入由回收、删除、退出各自检查。这里只负责执行资源的收尾。 */
	private finish(): Promise<void> {
		const resources = this.resources;
		if (resources.state === "unloaded") return Promise.resolve();
		if (resources.state === "closing") return resources.task;
		const execution = resources.execution;
		const manager = execution.ready ? execution.runtime.session.sessionManager : this.manager;
		if (execution.ready) this.scopedModels = modelScope(execution.runtime);
		const task = Promise.resolve().then(async () => {
			await execution.dispose();
			this.manager = this.stamp !== undefined || this.file && existsSync(this.file) ? undefined : manager;
			this.resources = { state: "unloaded" };
			this.changed();
		});
		this.resources = { state: "closing", task };
		return task;
	}
}
