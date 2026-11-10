import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { actionSchema, type GuiAction, type GuiActionResult } from "../shared/protocol/actions.ts";
import { querySchema, type GuiQuery, type GuiQueryResults } from "../shared/protocol/queries.ts";
import { type SessionTarget } from "../shared/protocol/state.ts";
import { type GuiAttention } from "../shared/protocol/connection.ts";
import { type GuiEvent } from "../shared/protocol/events.ts";
import type { GuiDelivery } from "../shared/protocol/sync.ts";
import type { GuiHost } from "./host.ts";
import type { GuiSession } from "./session/session.ts";
import type { GuiExecution, SessionClient } from "./session/execution.ts";
import { GuiChannel } from "./channel.ts";
import { readGuiConfig, saveGuiConfig } from "./config/preferences.ts";
import { readModuleConfig, saveModuleConfig } from "./config/module-config.ts";
import { resolveSearchApiKey } from "../../harness/web-tools/search-providers/api-key.ts";
import { readMcpConfig, saveMcpConfig } from "./config/mcp-config.ts";
import { readModelServices, saveModelServices } from "./config/model-services.ts";
import { listDirectories } from "./workspace/directories.ts";
import { importSession } from "./session/files.ts";
import { FileResources } from "./workspace/file-resource.ts";
import { GuiStorage } from "./storage/service.ts";
import { SessionSearchTask } from "./catalog/search-task.ts";
import { readSessionPaths } from "./catalog/session-index.ts";
import { workspaceExists } from "./catalog/workspaces.ts";

const validateAction = compile(actionSchema).check;
const validateQuery = compile(querySchema).check;

/** 每个连接独立导航。操作始终使用提交时的会话标识。 */
export class GuiClient {
	readonly id = randomUUID();
	private readonly resources = new FileResources(this.id);
	private readonly storage: GuiStorage;
	private readonly search: SessionSearchTask;
	resolveFileResource(token: string) {
		if (this.closed) throw new Error("客户端已断开。");
		return this.resources.resolve(token, this.selected?.cwd ?? this.host.workspaceRoot);
	}
	selected: GuiSession | undefined;
	allSessions = false;
	private listeners = new Set<(event: GuiEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeHost: () => void;
	private closed = false;
	private observing = true;
	private attention: GuiAttention | null = null;
	get focused(): boolean { return this.attention?.focused === true; }
	get notificationDestination(): string | null { return this.attention?.destination ?? null; }
	private selection = 0;
	private drafts = new Map<string, string>();
	private lastViewed = new Map<string, string>();
	private pendingSessions = new Map<string, GuiSession>();
	private creatingSessions = new Map<string, Promise<{ cancelled: boolean }>>();

	constructor(readonly host: GuiHost) {
		this.storage = new GuiStorage(host);
		this.search = new SessionSearchTask(host.sessionSearch, (error) => this.reportError(error));
		this.unsubscribeHost = host.subscribe((event) => {
			if (event.type === "sessionsDeleted") {
				for (const id of event.ids) this.drafts.delete(id);
				for (const [cwd, session] of this.pendingSessions) if (event.ids.includes(session.id)) this.pendingSessions.delete(cwd);
				for (const [cwd, id] of this.lastViewed) if (event.ids.includes(id)) this.lastViewed.delete(cwd);
			}
			this.emit(event);
		});
	}
	get runtime() { return this.execution.runtime; }
	get execution(): GuiExecution {
		const execution = this.selected?.execution;
		if (!execution) throw new Error("会话尚未就绪。");
		return execution;
	}
	emit(event: GuiEvent): void { for (const listener of this.listeners) listener(event); }
	reportError(error: unknown): void { this.emit({ type: "feedback", message: error instanceof Error ? error.message : String(error), tone: "error" }); }
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
		const channel = new GuiChannel(send);
		const receive = (event: GuiEvent) => channel.accept(event);
		const unsubscribe = this.subscribe(receive);
		this.replay(receive);
		return {
			attend: (value: GuiAttention) => { this.attention = value; },
			acknowledge: (id: number) => channel.acknowledge(id),
			close: () => { this.attention = null; unsubscribe(); channel.close(); },
		};
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
	async select(session: GuiSession, draftFrom?: string): Promise<void> {
		if (this.closed) throw new Error("客户端已断开。");
		const previous = this.selected;
		const version = ++this.selection;
		const refreshing = session.refreshCached();
		this.unbind();
		this.selected = session;
		this.host.catalog.schedule();
		if (session.pending) this.pendingSessions.set(session.cwd, session);
		this.emit({ ...this.selectionEvent(), ...(draftFrom ? { draftFrom } : {}) });
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
				this.host.catalog.schedule();
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
			newSession: (options) => this.newSession(session, options),
			fork: (entryId, options) => this.fork(session, entryId, options),
			switchSession: (file, options) => this.switchSession(file, options),
		};
	}
	private async newSession(source: GuiSession, options?: Parameters<ExtensionCommandContext["newSession"]>[0]) {
		if (options === undefined) {
			const creating = this.creatingSessions.get(source.cwd);
			if (creating) return creating;
			const pending = this.pendingSessions.get(source.cwd);
			const task = this.createSession(pending?.pending && !pending.removing ? pending : source);
			this.creatingSessions.set(source.cwd, task);
			try { return await task; }
			finally { this.creatingSessions.delete(source.cwd); }
		}
		return this.createSession(source, options);
	}
	private async createSession(source: GuiSession, options?: Parameters<ExtensionCommandContext["newSession"]>[0]) {
		const manager = SessionManager.create(source.cwd);
		if (options?.parentSession) manager.newSession({ parentSession: options.parentSession });
		await source.use(this.forSession(source), async (execution) => {
			const { model, thinkingLevel } = execution.runtime.session;
			if (model) manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange(thinkingLevel);
		});
		if (options?.setup) await options.setup(manager);
		const session = this.host.register(manager, { type: "session_start", reason: "new", previousSessionFile: source.file });
		const replacing = options === undefined && source.pending;
		if (replacing) this.drafts.set(session.id, this.readDraft(source.id));
		await this.select(session, replacing ? source.id : undefined);
		if (replacing && !source.observed && source.canRelease) {
			if (this.host.initial === source) this.host.initial = session;
			await this.host.remove([source.file]);
		}
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
	private async fork(source: GuiSession, entryId: string, options?: Parameters<ExtensionCommandContext["fork"]>[1]) {
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
				manager = SessionManager.open(source.file);
				manager.createBranchedSession(target);
			} else {
				manager = SessionManager.create(source.cwd);
				manager.newSession({ parentSession: source.file });
			}
			const selectedText = position === "before" && entry.type === "message" && entry.message.role === "user"
				? typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((block) => block.type === "text").map((block) => block.text).join("") : undefined;
			const forked = this.host.register(manager, { type: "session_start", reason: "fork", previousSessionFile: source.file });
			await this.select(forked);
			if (selectedText) this.emit({ type: "editor", sessionId: forked.id, text: selectedText, mode: "replace" });
			if (options?.withSession) await options.withSession(this.runtime.session.createReplacedSessionContext());
			return { cancelled: false, ...(selectedText === undefined ? {} : { selectedText }) };
		}));
	}

	dispatch<A extends GuiAction>(action: A, sessionId?: string | null): Promise<GuiActionResult<A>>;
	dispatch(value: unknown, sessionId?: string | null): Promise<GuiActionResult>;
	dispatch(value: unknown, sessionId: string | null = this.selected?.id ?? null): Promise<GuiActionResult> {
		return this.host.track(this.perform(value, sessionId));
	}
	private async perform(value: unknown, sessionId: string | null): Promise<GuiActionResult> {
		if (!validateAction(value)) throw new Error("无效 GUI 操作参数。");
		if (this.closed) throw new Error("客户端已断开。");
		const action = value;
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
			case "cancelSessionSearch": await this.search.cancel(action.id); return;
			case "removeStorage": await this.host.manageStorage(() => this.storage.remove(action.ids)); return;
			case "saveMcpConfig": await saveMcpConfig(action.original, action.content); return;
			case "saveModelServices": await saveModelServices(action.original, action.content); return;
			case "saveModuleConfig": await saveModuleConfig(action.id, action.original, action.content); return;
			case "saveGuiConfig": this.host.applyGuiConfig(await saveGuiConfig(action.original, action.content)); return;
			case "startupChangelog": await this.host.changelog.finish(this.id, action.shown); return;
			case "sessions":
				this.allSessions = action.all === true;
				await this.host.catalog.refresh(); return;
			case "openSession": await this.openSession(action); return;
			case "workspace": {
				const cwd = path.resolve(sessionId === null ? this.host.workspaceRoot : this.resolveSession(sessionId).cwd, action.path);
				const remembered = this.lastViewed.get(cwd);
				let recent = (remembered ? this.host.sessions.get(remembered) : undefined)
					?? [...this.host.sessions.values()].filter((session) => session.cwd === cwd && !session.removing).sort((a, b) => b.lastUsed - a.lastUsed)[0];
				if (!recent && !await workspaceExists(cwd)) {
					const [file] = await readSessionPaths(cwd);
					if (!file) throw new Error("工作目录不存在或不是文件夹。");
					recent = await this.host.openFile(file);
				}
				await this.select(recent ?? this.host.newSession(cwd)); return;
			}
			case "import": await this.select(this.host.register(await importSession(action.content))); return;
			case "deleteSession": await this.host.remove([action.path]); return;
			case "removeWorkspace": {
				if (action.path === this.host.workspaceRoot || [...this.host.clients].some((client) => client.selected?.cwd === action.path))
					throw new Error("不能移除启动目录或当前工作区。");
				const files = [...new Set([
					...await readSessionPaths(action.path),
					...[...this.host.sessions.values()].filter((session) => session.cwd === action.path).map((session) => session.file),
				])];
				if (!files.length) throw new Error("工作区已不在列表中。");
				await this.host.remove(files); return;
			}
			case "renameSession": await this.host.rename(action.path, action.name, this); return;
			case "autoTitleSession": {
				const target = await this.host.openFile(action.path);
				await target.refreshCached();
				const client = this.forSession(target);
				await target.use(client, (execution) => execution.generateTitle(client));
				return;
			}
		}
		const source = this.resolveSession(sessionId);
		if (action.action === "new") { await this.newSession(source); return; }
		if (action.action === "fork") { await this.fork(source, action.entryId); return; }
		const client = this.forSession(source);
		if (action.action === "restoreSession") {
			await source.use(client, (execution) => execution.change(async () => {
				const cwd = path.resolve(source.cwd, action.path);
				if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
				SessionManager.forkFrom(source.file, cwd);
				await this.host.catalog.refresh();
			}));
			return;
		}
		if (action.action === "dialog" || action.action === "abort" || action.action === "cancelLogin") return source.control(action, client);
		return source.use(client, (execution) => execution.dispatch(action, client));
	}
	query<Q extends GuiQuery>(query: Q, sessionId?: string | null): Promise<GuiQueryResults[Q["query"]]>;
	query(query: unknown, sessionId?: string | null): Promise<GuiQueryResults[GuiQuery["query"]]>;
	query(value: unknown, sessionId: string | null = this.selected?.id ?? null): Promise<GuiQueryResults[GuiQuery["query"]]> {
		return this.host.track(this.readQuery(value, sessionId));
	}
	private async readQuery(value: unknown, sessionId: string | null): Promise<GuiQueryResults[GuiQuery["query"]]> {
		if (!validateQuery(value)) throw new Error("无效 GUI 查询参数。");
		if (this.closed) throw new Error("客户端已断开。");
		const query = value;
		if (query.query === "searchSessions") {
			if (query.cwd !== (this.selected?.cwd ?? this.host.workspaceRoot)) throw new Error("工作区已切换，请重新搜索。");
			return this.search.start(query.cwd, query.text);
		}
		if (query.query === "continueSessionSearch") return this.search.next(query.id);
		if (query.query === "storage") return this.host.manageStorage(() => this.storage.read());
		if (query.query === "mcpConfig") return readMcpConfig();
		if (query.query === "modelServices") return readModelServices();
		if (query.query === "guiConfig") return readGuiConfig();
		if (query.query === "startupChangelog") return this.host.changelog.read(this.id, this.host.workspaceRoot);
		if (query.query === "availableVersion") return this.host.checkVersion();
		if (query.query === "moduleConfig") return readModuleConfig(query.id);
		if (query.query === "searchApiKeyAvailable") return resolveSearchApiKey(query.config) !== undefined;
		if (query.query === "directories") return listDirectories(path.resolve(this.host.workspaceRoot || process.cwd(), query.path));
		if (query.query === "workspaceFiles" || query.query === "workspaceGit" || query.query === "previewFile" || query.query === "lspServers") {
			if (query.cwd !== (this.selected?.cwd ?? this.host.workspaceRoot)) throw new Error("工作区已切换，请刷新后重试。");
			if (query.query === "lspServers") return this.host.queryWorkspace(query);
			if (query.query !== "previewFile") return this.host.queryWorkspace(query);
			const preview = await this.host.queryWorkspace(query);
			const content = preview.content;
			return { ...preview, content: content.kind === "image" || content.kind === "pdf"
				? { ...content, url: this.resources.url({ cwd: query.cwd, path: query.path, version: content.version, mime: content.mime, size: content.size }) }
				: content };
		}
		const session = this.resolveSession(sessionId);
		return session.use(this.forSession(session), (execution) => execution.query(query));
	}
	private resolveSession(id: string | null): GuiSession {
		const session = id === null ? undefined : this.host.sessions.get(id);
		if (!session) throw new Error("请先选择有效会话。");
		return session;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.selection++;
		this.unbind(); this.unsubscribeHost();
		this.storage.dispose();
		void this.host.track(this.search.close()).catch((error: unknown) => this.host.reportError(error));
		this.host.changelog.release(this.id);
		this.host.clients.delete(this);
		this.host.catalog.schedule();
		this.listeners.clear();
	}
}
