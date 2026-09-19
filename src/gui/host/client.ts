import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { compileSchemaValidator } from "../../harness/schema-validator.ts";
import { actionSchema, querySchema, type SessionTarget, type GuiAction, type GuiEvent, type GuiQuery, type GuiQueryResults } from "../contract.ts";
import type { GuiDelivery } from "../sync.ts";
import type { GuiHost } from "./host.ts";
import type { GuiSession } from "./session.ts";
import type { GuiExecution, SessionClient } from "./execution.ts";
import { GuiChannel } from "./channel.ts";
import { readGuiConfig, saveGuiConfig } from "./preferences.ts";
import { readModuleConfig, saveModuleConfig } from "./module-config.ts";
import { listDirectories } from "./directories.ts";
import { importSession } from "./files.ts";

const validateAction = compileSchemaValidator(actionSchema);
const validateQuery = compileSchemaValidator(querySchema);

/** 每个连接独立导航。操作始终使用提交时的会话标识。 */
export class GuiClient {
	readonly id = randomUUID();
	selected: GuiSession | undefined;
	private listeners = new Set<(event: GuiEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeHost: () => void;
	private closed = false;
	private observing = true;
	private selection = 0;
	private drafts = new Map<string, string>();
	private lastViewed = new Map<string, string>();

	constructor(readonly host: GuiHost) {
		this.unsubscribeHost = host.subscribe((event) => {
			if (event.type === "sessionsDeleted") {
				for (const id of event.ids) this.drafts.delete(id);
				for (const [cwd, id] of this.lastViewed) if (event.ids.includes(id)) this.lastViewed.delete(cwd);
			}
			this.emit(event);
		});
	}
	get runtime() { return this.execution.runtime; }
	get dialogs() { return this.execution.dialogs; }
	get execution(): GuiExecution {
		const execution = this.selected?.execution;
		if (!execution) throw new Error("会话尚未就绪。");
		return execution;
	}
	snapshot() { return this.execution.snapshot(); }
	emit(event: GuiEvent): void { for (const listener of this.listeners) listener(event); }
	reportError(error: unknown): void { this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
	subscribe(listener: (event: GuiEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	replay(listener: (event: GuiEvent) => void): void {
		this.host.replay(listener);
		listener(this.selectionEvent());
		if (this.selected) this.selected.replay(listener);
		else listener({ type: "snapshot", value: null });
	}
	connect(send: (delivery: GuiDelivery) => void) {
		const channel = new GuiChannel(() => this.execution.payloads, send);
		const receive = (event: GuiEvent) => channel.accept(event);
		const unsubscribe = this.subscribe(receive);
		this.replay(receive);
		return { acknowledge: (id: number) => channel.acknowledge(id), close: () => { unsubscribe(); channel.close(); } };
	}
	private selectionEvent(): Extract<GuiEvent, { type: "selected" }> {
		const session = this.selected;
		return { type: "selected", session: session ? { id: session.id, cwd: session.cwd, path: session.file } : null };
	}
	private unbind(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
	private bind(): void {
		this.unbind();
		if (this.observing && this.selected) {
			this.unsubscribe = this.selected.subscribe((event) => this.emit(event));
			this.selected.replay((event) => this.emit(event));
		}
	}
	async select(session: GuiSession): Promise<void> {
		if (this.closed) throw new Error("客户端已断开。");
		const previous = this.selected;
		const version = ++this.selection;
		const refreshing = session.refreshCached();
		this.unbind();
		this.selected = session;
		this.emit(this.selectionEvent());
		this.emit({ type: "dialogs", value: [] });
		this.emit({ type: "notices", value: [] });
		this.emit({ type: "auth", value: null });
		this.bind();
		try {
			if (refreshing) await refreshing;
			if (version !== this.selection || this.closed) return;
			await session.ensure(this.forSession(session));
			if (version === this.selection) this.lastViewed.set(session.cwd, session.id);
		} catch (error) {
			if (version === this.selection) {
				this.unbind();
				this.selected = previous;
				this.emit(this.selectionEvent());
				this.bind();
			}
			throw error;
		}
	}

	readDraft(sessionId: string): string { return this.drafts.get(sessionId) ?? ""; }
	forSession(session: GuiSession): SessionClient {
		return {
			readDraft: () => this.readDraft(session.id),
			writeDraft: (text) => { if (this.host.sessions.get(session.id) === session) this.drafts.set(session.id, text); },
			emit: (event) => { if (!this.closed && (event.type === "download" || event.type === "editor" || this.selected === session)) this.emit(event); },
			dispatch: (action) => this.dispatch(action, session.id),
			newSession: (options) => this.newSession(options, session),
			fork: (entryId, options) => this.fork(entryId, options, session),
			switchSession: (file, options) => this.switchSession(file, options),
		};
	}
	async newSession(options?: Parameters<ExtensionCommandContext["newSession"]>[0], source = this.selected) {
		if (!source) throw new Error("请先选择工作区。");
		const manager = SessionManager.create(source.cwd);
		if (options?.parentSession) manager.newSession({ parentSession: options.parentSession });
		if (options?.setup) await options.setup(manager);
		const session = this.host.register(manager, { type: "session_start", reason: "new", ...(source.file ? { previousSessionFile: source.file } : {}) });
		await this.select(session);
		if (options?.withSession) await options.withSession(this.runtime.session.createReplacedSessionContext());
		return { cancelled: false };
	}
	async openSession(target: SessionTarget): Promise<void> {
		const session = "id" in target ? this.host.sessions.get(target.id) : await this.host.openFile(target.path);
		if (!session) throw new Error("会话已不存在。");
		await this.select(session);
	}
	async switchSession(file: string, options?: Parameters<ExtensionCommandContext["switchSession"]>[1]) {
		await this.openSession({ path: file });
		if (options?.withSession) await options.withSession(this.runtime.session.createReplacedSessionContext());
		return { cancelled: false };
	}
	async fork(entryId: string, options?: Parameters<ExtensionCommandContext["fork"]>[1], source = this.selected) {
		if (!source) throw new Error("请先选择工作区。");
		return source.use(this.forSession(source), (execution) => execution.change(async () => {
			const session = execution.runtime.session;
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
		const source = sessionId ? this.host.sessions.get(sessionId) : undefined;
		switch (action.action) {
			case "observe": {
				if (this.observing === action.visible) return;
				this.observing = action.visible;
				const session = this.selected;
				if (!action.visible) this.unbind();
				else if (session) {
					await session.refreshCached();
					if (!this.observing || this.closed || this.selected !== session) return;
					this.bind();
					await session.ensure(this.forSession(session));
				}
				return;
			}
			case "saveModuleConfig": await saveModuleConfig(action.id, action.original, action.content); return;
			case "saveGuiConfig": this.host.applyGuiConfig(await saveGuiConfig(action.original, action.content)); return;
			case "sessions": await this.host.catalog.refresh(); return;
			case "openSession": await this.openSession(action); return;
			case "workspace": {
				const cwd = path.resolve(source?.cwd ?? this.host.workspaceRoot, action.path);
				if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
				const remembered = this.lastViewed.get(cwd);
				const recent = (remembered ? this.host.sessions.get(remembered) : undefined)
					?? [...this.host.sessions.values()].filter((session) => session.cwd === cwd && !session.removing).sort((a, b) => b.lastUsed - a.lastUsed)[0];
				await this.select(recent ?? await this.host.newSession(cwd)); return;
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
					...[...this.host.sessions.values()].flatMap((session) => session.cwd === action.path && session.file ? [session.file] : []),
				])];
				if (!files.length) throw new Error("工作区已不在列表中。");
				await this.host.remove(files); return;
			}
			case "renameSession": await this.host.rename(action.path, action.name, this); return;
		}
		if (!source) throw new Error("请先选择有效会话。");
		const client = this.forSession(source);
		// 启动中的信任确认不能等待被该确认阻塞的启动 Promise。
		if (["dialog", "abort", "cancelLogin"].includes(action.action) && source.execution) {
			await source.execution.dispatch(action, client); return;
		}
		await source.use(client, (execution) => execution.dispatch(action, client));
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
		if (query.query === "workspaceFiles" || query.query === "workspaceGit" || query.query === "previewFile") {
			if (query.cwd !== (this.selected?.cwd ?? this.host.workspaceRoot)) throw new Error("工作区已切换，请刷新后重试。");
			return this.host.queryWorkspace(query);
		}
		const session = sessionId ? this.host.sessions.get(sessionId) : undefined;
		if (!session) throw new Error("请先选择有效会话。");
		return session.use(this.forSession(session), (execution) => execution.query(query));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.selection++;
		this.unbind(); this.unsubscribeHost();
		this.host.clients.delete(this);
		this.listeners.clear();
	}
}
