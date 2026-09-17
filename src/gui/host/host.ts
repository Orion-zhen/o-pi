import path from "node:path";
import { stat } from "node:fs/promises";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { UserHistoryStore, buildInitialHistory } from "../../harness/user-history.ts";
import { compileSchemaValidator } from "../../harness/schema-validator.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import { actionSchema, querySchema, type GuiAction, type GuiEvent, type GuiQuery, type GuiQueryResults, type GuiSnapshot } from "../contract.ts";
import { MessageTiming } from "./message-timing.ts";
import { GuiDialogs } from "./dialogs.ts";
import { createGuiRuntime } from "./runtime.ts";
import { exportSession, importSession, completeFiles, expandAttachments, readConfig, saveConfig } from "./files.ts";
import { runLogin } from "./login.ts";
import { completeCommand, runBuiltin } from "./commands.ts";
import { openView } from "./views.ts";
import { collectGuiSnapshot } from "./snapshot.ts";
import { persistModelScope, setModelScope } from "./models.ts";
import { GuiSessionCatalog, renameSavedSession } from "./sessions.ts";
import { GuiSessionInfo } from "./session-info.ts";
import { prepareSessionDeletion } from "./delete-session.ts";
import { listDirectories } from "./directories.ts";
import { setWorkspaceRemoved } from "./workspaces.ts";
import type { ReadSessionInfo } from "./extensions.ts";
import { listWorkspaceFiles, previewWorkspaceFile } from "./workspace-files.ts";
import { readWorkspaceGit } from "./workspace-git.ts";
import { readGuiConfig, saveGuiConfig } from "./preferences.ts";

const validateAction = compileSchemaValidator(actionSchema);
const validateQuery = compileSchemaValidator(querySchema);
type QueryResult = GuiQueryResults[GuiQuery["query"]];

/** 图形宿主只维护交互与生命周期，业务状态从 SDK 读取。 */
export class GuiHost {
	private current: AgentSessionRuntime | undefined;
	private workspaceRoot: string | undefined;
	private readSessionInfo: ReadSessionInfo | undefined;
	private history = new UserHistoryStore();
	private historyTexts: string[] = [];
	private historyWarned = false;
	private listeners = new Set<(event: GuiEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private changing = false;
	private preparing = 0;
	private commandController = new AbortController();
	private workbenchController = new AbortController();
	private workbenchCwd = "";
	private messageTiming = new MessageTiming();
	private liveTools = new Map<string, GuiSnapshot["liveTools"][number]>();
	private disposed = false;
	private tasks = new Set<Promise<unknown>>();
	private toolController: ToolSelectionController | undefined;
	private loginController: AbortController | undefined;
	private sessions = new GuiSessionCatalog((value, workspaces) => {
		this.emit({ type: "sessions", value });
		this.emit({ type: "workspaces", value: workspaces });
	}, () => [this.workspaceRoot ?? "", this.current?.cwd ?? ""]);
	private info = new GuiSessionInfo(
		(value) => this.emit({ type: "sessionInfo", value }),
		(error) => this.dialogs.notify(`会话信息读取失败: ${error instanceof Error ? error.message : String(error)}`, "error"),
	);
	readonly dialogs = new GuiDialogs((event) => this.emit(event));

	get runtime(): AgentSessionRuntime {
		if (!this.current) throw new Error("会话尚未就绪。");
		return this.current;
	}

	emit(event: GuiEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	subscribe(listener: (event: GuiEvent) => void): () => void {
		this.listeners.add(listener);
		if (this.workspaceRoot) listener({ type: "workspaceRoot", path: this.workspaceRoot });
		listener({ type: "dialogs", value: this.dialogs.list() });
		for (const value of this.dialogs.notices) listener({ type: "notice", value });
		listener({ type: "snapshot", value: this.current ? this.snapshot() : null });
		if (this.info.value) listener({ type: "sessionInfo", value: this.info.value });
		if (this.sessions.value) listener({ type: "sessions", value: this.sessions.value });
		if (this.sessions.workspaces) listener({ type: "workspaces", value: this.sessions.workspaces });
		this.scheduleInfo();
		return () => this.listeners.delete(listener);
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		return task.finally(() => this.tasks.delete(task));
	}

	start(cwd: string): Promise<void> {
		if (!this.workspaceRoot) {
			this.workspaceRoot = path.resolve(cwd);
			this.emit({ type: "workspaceRoot", path: this.workspaceRoot });
		}
		return this.track(this.change(() => this.initialize(cwd)));
	}

	private async initialize(cwd: string, sessionManager?: SessionManager): Promise<void> {
		const runtime = await createGuiRuntime(cwd, {
			dialogs: this.dialogs,
			emit: (event) => this.emit(event),
			bindTools: (controller) => { this.toolController = controller; },
			commandSignal: () => this.commandController.signal,
			bindSessionInfo: (read) => { this.readSessionInfo = read; },
		}, sessionManager);
		if (this.disposed) {
			await runtime.dispose();
			return;
		}
		this.current = runtime;
		runtime.setBeforeSessionInvalidate(() => {
			this.unsubscribe?.();
			this.toolController = undefined;
			this.readSessionInfo = undefined;
			this.info.invalidate();
			this.liveTools.clear();
			this.dialogs.cancel();
		});
		runtime.setRebindSession(() => this.bindSession());
		await this.bindSession();
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		if (this.workbenchCwd !== runtime.cwd) {
			this.workbenchController.abort();
			this.workbenchController = new AbortController();
			this.workbenchCwd = runtime.cwd;
		}
		await setWorkspaceRemoved(runtime.cwd, false);
		this.historyWarned = false;
		try {
			const records = await this.history.load(runtime.cwd);
			const messages = session.messages.flatMap((message) => message.role === "user" ? [{
				timestamp: message.timestamp,
				text: typeof message.content === "string" ? message.content : message.content
					.filter((content) => content.type === "text").map((content) => content.text).join("\n"),
			}] : []);
			this.historyTexts = buildInitialHistory(records, messages, session.sessionId);
		} catch (error) {
			this.historyTexts = [];
			this.historyError(error);
		}
		this.unsubscribe?.();
		this.messageTiming = new MessageTiming();
		this.unsubscribe = session.subscribe((event) => {
			this.messageTiming.accept(event);
			if (event.type === "tool_execution_start" || event.type === "tool_execution_update")
				this.liveTools.set(event.toolCallId, event);
			if (event.type === "tool_execution_end") this.liveTools.delete(event.toolCallId);
			if (event.type === "agent_end") this.refreshSessions();
			this.schedule();
		});
		await session.bindExtensions({
			// SDK 尚无 gui 模式。print + 真实 uiContext 提供 hasUI，不启动任何运行模式。
			mode: "print",
			uiContext: this.dialogs.context(),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: (entryId, options) => runtime.fork(entryId, options),
				navigateTree: (entryId, options) => session.navigateTree(entryId, options),
				switchSession: (file, options) => runtime.switchSession(file, options),
				reload: () => session.reload(),
			},
			shutdownHandler: () => this.emit({ type: "close" }),
			onError: (error) => this.dialogs.notify(`${error.extensionPath}: ${error.error}`, "error"),
		});
		this.publish();
		this.refreshSessions();
	}

	private refreshSessions(): void {
		if (this.disposed) return;
		void this.sessions.refresh().catch((error: unknown) => {
			if (!this.disposed)
				this.dialogs.notify(`会话列表读取失败: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	}

	private get idle(): boolean {
		return (!this.current || this.current.session.isIdle && !this.current.session.isBashRunning)
			&& !this.loginController && this.preparing === 0;
	}

	snapshot(): GuiSnapshot {
		return collectGuiSnapshot(this.runtime, {
			canSubmit: !this.changing,
			canChangeSession: !this.changing && this.idle,
			commandRunning: this.preparing > 0,
			liveTools: [...this.liveTools.values()],
			messageDurations: { ...this.messageTiming.durations },
			history: this.historyTexts,
			status: { ...this.dialogs.status },
		});
	}

	private schedule(): void {
		if (!this.timer && !this.disposed)
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.publish();
			}, 50);
	}

	private scheduleInfo(): void {
		if (!this.disposed && !this.changing && this.current && this.readSessionInfo)
			this.info.schedule(this.current.session, this.readSessionInfo);
	}

	publish(): void {
		if (this.disposed) return;
		this.emit({ type: "snapshot", value: this.current ? this.snapshot() : null });
		this.scheduleInfo();
	}

	async dispatch(value: unknown): Promise<void> {
		if (!validateAction(value)) throw new Error("无效 GUI 操作参数。");
		if (this.disposed) throw new Error("宿主已关闭。");
		await this.track(this.perform(value as GuiAction));
	}

	query<Q extends GuiQuery>(value: Q): Promise<GuiQueryResults[Q["query"]]>;
	query(value: unknown): Promise<QueryResult>;
	async query(value: unknown): Promise<QueryResult> {
		if (!validateQuery(value)) throw new Error("无效 GUI 查询参数。");
		if (this.disposed) throw new Error("宿主已关闭。");
		return this.track(this.readQuery(value as GuiQuery));
	}

	private async readQuery(query: GuiQuery): Promise<QueryResult> {
		if (query.query === "guiConfig") return readGuiConfig();
		if (query.query === "directories")
			return listDirectories(path.resolve(this.workspaceRoot ?? process.cwd(), query.path));
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const runtime = this.runtime;
		switch (query.query) {
			case "complete": return completeCommand(runtime.session, query.text);
			case "files": return completeFiles(runtime.cwd, query.prefix);
			case "config":
				await runtime.services.settingsManager.flush();
				return readConfig(query.file);
		}
		if (query.cwd !== runtime.cwd) throw new Error("工作区已切换，请刷新后重试。");
		const signal = this.workbenchController.signal;
		let result: QueryResult;
		switch (query.query) {
			case "workspaceFiles": result = await listWorkspaceFiles(query.cwd, query.path); break;
			case "workspaceGit": result = await readWorkspaceGit(query.cwd, signal); break;
			case "previewFile": result = await previewWorkspaceFile(query.cwd, query.path, signal); break;
		}
		signal.throwIfAborted();
		return result;
	}

	private async perform(action: GuiAction): Promise<void> {
		switch (action.action) {
			case "saveGuiConfig":
				this.emit({ type: "guiConfig", value: await saveGuiConfig(action.original, action.content) });
				return;
			case "dialog": this.dialogs.respond(action.id, action.value); return;
			case "draft": this.dialogs.draft = action.text; return;
			case "cancelLogin": this.loginController?.abort(); return;
			case "sessions": await this.sessions.refresh(); return;
			case "abort":
				this.dialogs.cancel();
				this.commandController.abort();
				this.commandController = new AbortController();
				this.loginController?.abort();
				if (this.current) {
					const session = this.current.session;
					session.abortBash();
					session.abortCompaction();
					session.abortBranchSummary();
					session.abortRetry();
					await session.abort();
				}
				this.publish();
				return;
		}
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		if (action.action === "deleteSession") return this.change(() => this.deleteSession(action.path));
		if (action.action === "removeWorkspace") return this.change(() => this.removeWorkspace(action.path));
		if (!this.current) {
			return this.change(async () => {
				if (action.action === "workspace") await this.initialize(action.path);
				else if (action.action === "switch") {
					if (!(await stat(action.path)).isFile()) throw new Error("会话路径不是文件。");
					const manager = SessionManager.open(action.path);
					await this.initialize(manager.getCwd(), manager);
				} else throw new Error("请先选择工作区。");
			});
		}
		const { session, services } = this.current;
		switch (action.action) {
			case "view": await openView(this, action.view, this.commandController.signal); return;
			case "prompt": await this.prompt(action); return;
			case "clearQueue": session.clearQueue(); this.publish(); return;
			case "export": await exportSession(session, action.format, (event) => this.emit(event)); return;
			case "login":
				if (this.loginController) throw new Error("已有登录流程正在进行。");
				this.loginController = new AbortController();
				this.publish();
				try {
					await runLogin(services.modelRuntime, action.provider, action.type, this.dialogs,
						(event) => this.emit(event), this.loginController.signal);
				} finally { this.loginController = undefined; this.publish(); }
				return;
			case "logout":
				try { await services.modelRuntime.logout(action.provider); }
				finally { this.publish(); }
				return;
			case "compact":
				if (session.isCompacting) throw new Error("压缩已在进行。");
				try { await session.compact(action.instructions || undefined); }
				finally { this.publish(); }
				return;
		}
		await this.change(() => this.mutate(action));
	}

	private async prompt(action: Extract<GuiAction, { action: "prompt" }>): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		if (action.text.trim()) {
			this.historyTexts = [...this.historyTexts, action.text.trim()].slice(-100);
			void this.history.append({ cwd: runtime.cwd, session: session.sessionId, text: action.text })
				.catch((error: unknown) => this.historyError(error));
		}
		this.publish();
		if (await runBuiltin(this, action.text, (action) => this.perform(action))) return;
		if (action.text.startsWith("!")) {
			try {
				await session.executeBash(action.text.replace(/^!!?/, ""), (chunk) => {
					this.dialogs.status["bash"] = ((this.dialogs.status["bash"] ?? "") + chunk).slice(-64_000);
					this.schedule();
				}, { excludeFromContext: action.text.startsWith("!!") });
			} finally {
				delete this.dialogs.status["bash"];
				this.refreshSessions();
				this.publish();
			}
			return;
		}
		const name = session.sessionName;
		this.preparing++;
		this.publish();
		try {
			const attachments = await expandAttachments(action.text, runtime.cwd);
			await session.prompt(attachments.text, {
				images: [...attachments.images, ...action.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }))],
				streamingBehavior: action.behavior,
				source: "interactive",
			});
		} finally {
			this.preparing--;
			if (session.sessionName !== name) this.refreshSessions();
			this.publish();
		}
	}

	private async change(operation: () => Promise<void>): Promise<void> {
		if (this.disposed) throw new Error("宿主已关闭。");
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		if (!this.idle) throw new Error("请先停止或等待当前操作结束。");
		this.changing = true;
		this.info.invalidate();
		this.publish();
		try { await operation(); }
		finally { this.changing = false; this.publish(); }
	}

	private async removeWorkspace(cwd: string): Promise<void> {
		if (cwd === this.workspaceRoot || cwd === this.current?.cwd) throw new Error("不能移除启动目录或当前工作区。");
		await this.sessions.refresh();
		if (!this.sessions.workspaces?.some((workspace) => workspace.path === cwd)) throw new Error("工作区已不在列表中。");
		await setWorkspaceRemoved(cwd, true);
		await this.sessions.refresh();
	}

	private async deleteSession(file: string): Promise<void> {
		if (this.dialogs.list().length) throw new Error("请先完成或取消当前对话框。");
		try {
			const plan = await prepareSessionDeletion(file, this.current?.session.sessionFile ?? null);
			if (this.disposed) return;
			await plan.verify();
			if (plan.affectsCurrent && this.current) {
				if ((await this.current.newSession()).cancelled) {
					this.dialogs.notify("会话切换被取消，未删除历史。");
					return;
				}
				this.dialogs.context().setEditorText("");
			}
			await plan.remove();
		} finally { await this.sessions.refresh(); }
	}

	private async mutate(action: GuiAction): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		switch (action.action) {
			case "new": await runtime.newSession(); break;
			case "workspace": {
				const cwd = path.resolve(runtime.cwd, action.path);
				if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
				await runtime.dispose();
				this.current = undefined;
				await this.initialize(cwd);
				break;
			}
			case "switch":
				if (!(await stat(action.path)).isFile()) throw new Error("会话路径不是文件。");
				await runtime.switchSession(action.path);
				break;
			case "fork": {
				const result = await runtime.fork(action.entryId);
				if (!result.cancelled && result.selectedText) this.dialogs.context().setEditorText(result.selectedText);
				break;
			}
			case "navigate": {
				const result = await session.navigateTree(action.entryId, { summarize: action.summarize });
				if (result.editorText) this.dialogs.context().setEditorText(result.editorText);
				break;
			}
			case "label": session.sessionManager.appendLabelChange(action.entryId, action.label); break;
			case "renameSession":
				if (action.path === session.sessionFile) session.setSessionName(action.name);
				else await renameSavedSession(action.path, action.name);
				await this.sessions.refresh();
				break;
			case "rename": session.setSessionName(action.name); this.refreshSessions(); break;
			case "import": await importSession(runtime, action.content); break;
			case "reload": await session.reload(); break;
			case "model": {
				const model = runtime.services.modelRuntime.getModel(action.provider, action.id);
				if (!model) throw new Error("模型不存在。");
				await session.setModel(model, { persist: false });
				break;
			}
			case "thinking":
				session.setThinkingLevel(action.level);
				runtime.services.settingsManager.setDefaultThinkingLevel(session.thinkingLevel);
				break;
			case "scopeModels": setModelScope(runtime, action.models); break;
			case "persistModels": await persistModelScope(runtime); break;
			case "settings":
				session.setAutoCompactionEnabled(action.compaction);
				session.setAutoRetryEnabled(action.retry);
				session.setSteeringMode(action.steering);
				session.setFollowUpMode(action.followUp);
				runtime.services.settingsManager.setImageAutoResize(action.autoResize);
				runtime.services.settingsManager.setBlockImages(action.blockImages);
				await runtime.services.settingsManager.flush();
				break;
			case "tool":
			case "persistTools":
				if (!this.toolController) throw new Error("工具选择未绑定。");
				if (action.action === "tool") this.toolController.set(action.name, action.enabled);
				else this.dialogs.notify(`已保存: ${await this.toolController.persistUserDefaults()}`);
				break;
			case "saveConfig":
				await runtime.services.settingsManager.flush();
				await saveConfig(action.file, action.original, action.content);
				await session.reload();
				break;
		}
	}

	private historyError(error: unknown): void {
		if (this.historyWarned) return;
		this.historyWarned = true;
		this.dialogs.notify(`输入历史不可用: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const sessionsClosed = this.sessions.dispose();
		const infoClosed = this.info.dispose();
		clearTimeout(this.timer);
		this.loginController?.abort();
		this.commandController.abort();
		this.workbenchController.abort();
		this.dialogs.cancel();
		if (this.current) {
			this.current.session.abortBash();
			await this.current.session.abort();
		}
		await Promise.allSettled([...this.tasks]);
		this.unsubscribe?.();
		await this.current?.dispose();
		await this.history.flush();
		await Promise.all([sessionsClosed, infoClosed]);
		this.listeners.clear();
	}
}
