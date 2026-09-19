import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { compileSchemaValidator } from "../../harness/schema-validator.ts";
import { actionSchema, querySchema, type GuiAction, type GuiEvent, type GuiQuery, type GuiQueryResults } from "../contract.ts";
import type { GuiDelivery } from "../sync.ts";
import type { GuiHost, SessionSlot } from "./host.ts";
import type { GuiSession, SessionClient } from "./session.ts";
import { GuiChannel } from "./channel.ts";
import { GuiPayloads } from "./payloads.ts";
import { readGuiConfig, saveGuiConfig } from "./preferences.ts";
import { readModuleConfig, saveModuleConfig } from "./module-config.ts";
import { listDirectories } from "./directories.ts";
import { importSession } from "./files.ts";

const validateAction = compileSchemaValidator(actionSchema);
const validateQuery = compileSchemaValidator(querySchema);

/** 每个连接独立导航。操作始终使用提交时的会话标识。 */
export class GuiClient {
	readonly id = randomUUID();
	selected: SessionSlot | undefined;
	private listeners = new Set<(event: GuiEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeHost: () => void;
	private emptyPayloads = new GuiPayloads();
	private closed = false;
	private observing = true;
	private selection = 0;
	private drafts = new Map<string, string>();
	private lastViewed = new Map<string, string>();

	constructor(readonly host: GuiHost) {
		this.unsubscribeHost = host.subscribe((event) => this.emit(event));
	}
	get runtime() { return this.session.runtime; }
	get dialogs() { return this.session.dialogs; }
	get session(): GuiSession {
		const instance = this.selected?.instance;
		if (!instance) throw new Error("会话尚未就绪。");
		return instance;
	}
	snapshot() { return this.session.snapshot(); }
	emit(event: GuiEvent): void { for (const listener of this.listeners) listener(event); }
	reportError(error: unknown): void { this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
	subscribe(listener: (event: GuiEvent) => void): () => void {
		this.listeners.add(listener);
		const replay = this.host.subscribe(listener);
		replay();
		listener({ type: "selected", sessionId: this.selected?.id ?? null });
		if (this.selected?.instance) {
			const detach = this.selected.instance.subscribe((event) => listener(event));
			detach();
		} else listener({ type: "snapshot", value: null });
		return () => this.listeners.delete(listener);
	}
	connect(send: (delivery: GuiDelivery) => void) {
		const channel = new GuiChannel(() => this.selected?.instance?.payloads ?? this.emptyPayloads, send);
		const unsubscribe = this.subscribe((event) => channel.accept(event));
		return { acknowledge: (id: number) => channel.acknowledge(id), close: () => { unsubscribe(); channel.close(); } };
	}
	private unbind(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
	bind(instance: GuiSession): void {
		this.unsubscribe?.();
		if (!this.observing) return;
		this.unsubscribe = instance.subscribe((event) => this.emit(event));
	}
	async select(slot: SessionSlot): Promise<void> {
		if (this.closed) throw new Error("客户端已断开。");
		const previous = this.selected;
		const version = ++this.selection;
		const refreshing = this.host.refreshCached(slot);
		if (refreshing) await refreshing;
		if (version !== this.selection || this.closed) return;
		this.unbind();
		previous?.users.delete(this);
		if (previous) { previous.lastUsed = Date.now(); this.host.captureFile(previous); }
		this.selected = slot;
		if (this.observing) slot.users.add(this);
		this.emit({ type: "selected", sessionId: slot.id });
		this.emit({ type: "dialogs", value: [] });
		this.emit({ type: "notices", value: [] });
		this.emit({ type: "auth", value: null });
		if (slot.instance && !slot.closing) this.bind(slot.instance);
		else this.emit({ type: "snapshot", value: null });
		try {
			await this.host.ensure(slot, this);
			if (version === this.selection) this.lastViewed.set(slot.cwd, slot.id);
		} catch (error) {
			if (version === this.selection) {
				this.unbind();
				slot.users.delete(this);
				this.selected = previous;
				if (previous) {
					if (this.observing) previous.users.add(this);
					this.emit({ type: "selected", sessionId: previous.id });
					if (previous.instance) this.bind(previous.instance);
				} else this.emit({ type: "selected", sessionId: null });
			}
			throw error;
		} finally { this.host.scheduleCollection(); }
	}

	readDraft(sessionId: string): string { return this.drafts.get(sessionId) ?? ""; }
	forSession(slot: SessionSlot): SessionClient {
		return {
			readDraft: () => this.readDraft(slot.id),
			writeDraft: (text) => { this.drafts.set(slot.id, text); },
			emit: (event) => { if (!this.closed && (event.type === "download" || event.type === "editor" || this.selected === slot)) this.emit(event); },
			dispatch: (action) => this.dispatch(action, slot.id),
			newSession: (options) => this.newSession(options, slot),
			fork: (entryId, options) => this.fork(entryId, options, slot),
			switchSession: (file, options) => this.switchSession(file, options),
		};
	}

	async newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0], source = this.selected) {
		if (!source) throw new Error("请先选择工作区。");
		const manager = SessionManager.create(source.cwd);
		if (options?.parentSession) manager.newSession({ parentSession: options.parentSession });
		if (options?.setup) await options.setup(manager);
		const slot = this.host.register(manager, { type: "session_start", reason: "new", ...(source.file ? { previousSessionFile: source.file } : {}) });
		await this.select(slot);
		if (options?.withSession) await options.withSession(this.session.runtime.session.createReplacedSessionContext());
		return { cancelled: false };
	}
	async switchSession(file: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]) {
		if (options?.cwdOverride || options?.projectTrustContextFactory) throw new Error("GUI 会话恢复使用已保存的工作区和宿主信任策略。");
		await this.select(await this.host.openFile(file));
		if (options?.withSession) await options.withSession(this.session.runtime.session.createReplacedSessionContext());
		return { cancelled: false };
	}
	async fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1], source = this.selected) {
		if (!source) throw new Error("请先选择工作区。");
		return this.host.use(source, this, async (instance) => instance.change(async () => {
			const session = instance.runtime.session;
			const position = options?.position ?? "before";
			const before = await session.extensionRunner.emit({ type: "session_before_fork", entryId, position });
			if (before?.cancel) return { cancelled: true };
			const entry = session.sessionManager.getEntry(entryId);
			if (!entry || position === "before" && (entry.type !== "message" || entry.message.role !== "user"))
				throw new Error("分支起点不是有效消息。");
			const target = position === "at" ? entry.id : entry.parentId;
			let manager: SessionManager;
			if (target) {
				if (!source.file) throw new Error("会话尚未保存。");
				manager = SessionManager.open(source.file);
				manager.createBranchedSession(target);
			} else {
				manager = SessionManager.create(source.cwd);
				if (source.file) manager.newSession({ parentSession: source.file });
			}
			const selectedText = position === "before" && entry.type === "message" && entry.message.role === "user"
				? typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("") : undefined;
			const forked = this.host.register(manager, { type: "session_start", reason: "fork", ...(source.file ? { previousSessionFile: source.file } : {}) });
			await this.select(forked);
			if (selectedText) this.emit({ type: "editor", sessionId: forked.id, text: selectedText });
			if (options?.withSession) await options.withSession(this.runtime.session.createReplacedSessionContext());
			return { cancelled: false, ...(selectedText === undefined ? {} : { selectedText }) };
		}));
	}

	dispatch(value: unknown, sessionId: string | null = this.selected?.id ?? null): Promise<void> {
		return this.host.track(this.perform(value, sessionId));
	}
	private async perform(value: unknown, sessionId: string | null): Promise<void> {
		if (!validateAction(value)) throw new Error("无效 GUI 操作参数。");
		if (this.closed) throw new Error("客户端已断开。");
		const action = value as GuiAction;
		const source = sessionId ? this.host.slots.get(sessionId) : undefined;
		switch (action.action) {
			case "observe":
				if (this.observing === action.visible) return;
				this.observing = action.visible;
				if (this.selected) {
					if (action.visible) {
						const refreshing = this.host.refreshCached(this.selected);
						if (refreshing) await refreshing;
						if (!this.observing || this.closed) return;
						this.selected.users.add(this);
						if (this.selected.instance && !this.selected.closing) this.bind(this.selected.instance);
						await this.host.ensure(this.selected, this);
					} else { this.unbind(); this.selected.users.delete(this); this.host.captureFile(this.selected); this.selected.lastUsed = Date.now(); this.host.scheduleCollection(); }
				}
				return;
			case "saveModuleConfig": await saveModuleConfig(action.id, action.original, action.content); return;
			case "saveGuiConfig": this.host.applyGuiConfig(await saveGuiConfig(action.original, action.content)); return;
			case "sessions": await this.host.catalog.refresh(); return;
			case "switch": await this.switchSession(action.path); return;
			case "selectSession": {
				const slot = this.host.slots.get(action.id);
				if (!slot) throw new Error("会话已不存在。");
				await this.select(slot); return;
			}
			case "workspace": {
				const cwd = path.resolve(source?.cwd ?? this.host.workspaceRoot, action.path);
				if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
				const remembered = this.lastViewed.get(cwd);
				const recent = (remembered ? this.host.slots.get(remembered) : undefined)
					?? [...this.host.slots.values()].filter((slot) => slot.cwd === cwd && !slot.removing).sort((a, b) => b.lastUsed - a.lastUsed)[0];
				await this.select(recent ?? await this.host.newSlot(cwd)); return;
			}
			case "new": await this.newSession(undefined, source); return;
			case "fork": await this.fork(action.entryId, undefined, source); return;
			case "import": await this.select(this.host.register(await importSession(action.content))); return;
			case "deleteSession": await this.host.remove([action.path]); return;
			case "removeWorkspace": {
				if (action.path === this.host.workspaceRoot || [...this.host.clients].some((client) => client.selected?.cwd === action.path))
					throw new Error("不能移除启动目录或当前工作区。");
				await this.host.catalog.refresh();
				const files = [...new Set([
					...this.host.catalog.value?.filter((item) => item.cwd === action.path).map((item) => item.path) ?? [],
					...[...this.host.slots.values()].flatMap((slot) => slot.cwd === action.path && slot.file ? [slot.file] : []),
				])];
				if (!files.length) throw new Error("工作区已不在列表中。");
				await this.host.remove(files); return;
			}
			case "renameSession": await this.host.rename(action.path, action.name, this); return;
		}
		if (!source) throw new Error("请先选择有效会话。");
		// 启动中的信任确认必须能响应，不能等待被该确认阻塞的启动 Promise。
		if (["dialog", "abort", "cancelLogin"].includes(action.action) && source.instance) {
			await source.instance.dispatch(action, this.forSession(source)); return;
		}
		await this.host.use(source, this, (instance) => instance.dispatch(action, this.forSession(source)));
	}

	query<Q extends GuiQuery>(query: Q, sessionId?: string | null): Promise<GuiQueryResults[Q["query"]]>;
	query(query: unknown, sessionId?: string | null): Promise<GuiQueryResults[GuiQuery["query"]]>;
	query(value: unknown, sessionId: string | null = this.selected?.id ?? null): Promise<GuiQueryResults[GuiQuery["query"]]> {
		return this.host.track(this.readQuery(value, sessionId));
	}
	private async readQuery(value: unknown, sessionId: string | null): Promise<GuiQueryResults[GuiQuery["query"]]> {
		if (!validateQuery(value)) throw new Error("无效 GUI 查询参数。");
		if (this.closed) throw new Error("客户端已断开。");
		const query = value as GuiQuery;
		if (query.query === "guiConfig") return readGuiConfig();
		if (query.query === "moduleConfig") return readModuleConfig(query.id);
		if (query.query === "directories") return listDirectories(path.resolve(this.host.workspaceRoot || process.cwd(), query.path));
		const slot = sessionId ? this.host.slots.get(sessionId) : undefined;
		if (!slot) throw new Error("请先选择有效会话。");
		return this.host.use(slot, this, (instance) => instance.query(query));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.selection++;
		this.unsubscribe?.(); this.unsubscribeHost();
		if (this.selected) { this.selected.users.delete(this); this.selected.lastUsed = Date.now(); }
		this.host.clients.delete(this);
		this.listeners.clear();
		this.host.scheduleCollection();
	}
}
