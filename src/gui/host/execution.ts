import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionManager, AgentSessionRuntime, SessionStartEvent, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UserHistoryStore, buildInitialHistory, normalizeHistoryText } from "../../harness/user-history.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import type { GuiAction, GuiEvent, SessionQuery, GuiQueryResults, GuiSnapshot } from "../contract.ts";
import type { ApprovalStores, SessionApprovalRules } from "../../harness/approval/rules/store.ts";
import { MessageTiming } from "./message-timing.ts";
import { GuiDialogs } from "./dialogs.ts";
import { createGuiRuntime } from "./runtime.ts";
import { exportSession, completeFiles, expandAttachments, readConfig, saveConfig } from "./files.ts";
import { runLogin } from "./login.ts";
import { completeCommand, runBuiltin } from "./commands.ts";
import { openView } from "./views.ts";
import { collectGuiSnapshot } from "./snapshot.ts";
import { GuiModelScope, persistDefaultModel } from "./models.ts";
import { GuiReports } from "./reports.ts";
import { GuiPayloads } from "./payloads.ts";
import { GuiHistory } from "./history.ts";
import { nestedMutation, NESTED_MUTATION_ENTRY } from "./nested-mutations.ts";
import type { GuiMcpTools } from "./mcp-tools.ts";

export interface SessionClient extends Pick<ExtensionCommandContext, "newSession" | "fork" | "switchSession"> {
	emit(event: GuiEvent): void;
	readDraft(): string;
	writeDraft(text: string): void;
	dispatch(action: GuiAction): Promise<void>;
}
type Listener = (event: GuiEvent) => void;

/** 可整体释放的 SDK 执行资源。导航和会话身份由 GuiSession 持有。 */
export class GuiExecution {
	private current: AgentSessionRuntime | undefined;
	private history = new UserHistoryStore();
	private historyTexts: string[] = [];
	private historyWarned = false;
	private observed = false;
	private unsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private changing = false;
	private preparing = 0;
	private commandController = new AbortController();
	private messageTiming = new MessageTiming();
	readonly payloads = new GuiPayloads();
	readonly modelScope = new GuiModelScope();
	private guiHistory = new GuiHistory(this.payloads);
	private bashOutput = "";
	private liveTools = new Map<string, GuiSnapshot["liveTools"][number]>();
	private disposed = false;
	private tasks = new Set<Promise<unknown>>();
	private background = new Set<() => void>();
	private toolController: ToolSelectionController | undefined;
	private mcpTools: GuiMcpTools | undefined;
	private loginController: AbortController | undefined;
	private mcpLoggingIn = false;
	private origin = new AsyncLocalStorage<SessionClient>();
	private reports = new GuiReports(
		(event) => this.emit(event),
		(error) => this.dialogs.notify(`会话信息读取失败: ${error instanceof Error ? error.message : String(error)}`, "error"),
	);
	readonly dialogs = new GuiDialogs((event) => {
		this.emit(event);
		this.changed();
	}, () => this.current ? this.current.session.messages.length + (this.current.session.state.streamingMessage ? 1 : 0) : 0, {
		get: () => this.origin.getStore()?.readDraft() ?? "",
		set: (text) => {
			this.origin.getStore()?.writeDraft(text);
			this.emit({ type: "editor", sessionId: this.id, text });
		},
	});

	constructor(readonly id: string, private receive: Listener, private changed: () => void, private refreshSessions: () => void, private submitted: () => void) {}

	get runtime(): AgentSessionRuntime {
		if (!this.current) throw new Error("会话尚未就绪。");
		return this.current;
	}
	get ready(): boolean { return this.current !== undefined && !this.changing; }
	get idle(): boolean {
		return (!this.current || this.current.session.isIdle && !this.current.session.isBashRunning)
			&& !this.loginController && this.preparing === 0;
	}
	get canRelease(): boolean {
		return this.ready && this.idle && this.tasks.size === 0 && this.dialogs.list().length === 0
			&& this.runtime.session.getSteeringMessages().length === 0 && this.runtime.session.getFollowUpMessages().length === 0;
	}
	get running(): boolean { return !this.idle; }

	emit(event: GuiEvent): void {
		if (["panel", "sessionTab", "editor", "download", "auth", "close"].includes(event.type)) {
			this.origin.getStore()?.emit(event);
			return;
		}
		this.receive(event);
	}
	observe(value: boolean): void {
		if (value === this.observed) return;
		this.observed = value;
		if (value) this.scheduleReports(); else this.reports.invalidate();
	}

	replay(listener: Listener): void {
		listener({ type: "dialogs", value: this.dialogs.list() });
		listener({ type: "notices", value: [...this.dialogs.notices] });
		listener({ type: "snapshot", value: this.current ? this.snapshot() : null });
		this.reports.replay(listener);
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		return task.finally(() => { this.tasks.delete(task); this.changed(); });
	}

	start(manager: SessionManager, permissions: { stores: ApprovalStores; rules: SessionApprovalRules; trust: Map<string, boolean> }, client: SessionClient | undefined, initial: { event: SessionStartEvent; models: string[] | undefined }): Promise<void> {
		const initialize = async () => {
			this.changing = true;
			try {
				const runtime = await createGuiRuntime(manager.getCwd(), {
					dialogs: this.dialogs,
					emit: (event) => this.emit(event),
					bindTools: (controller) => { this.toolController = controller; },
					bindMcp: (tools) => { this.mcpTools = tools; },
					toolsChanged: () => this.schedule(),
					commandSignal: () => this.commandController.signal,
					reports: this.reports,
					approvalStores: permissions.stores, approvalRules: permissions.rules, projectTrust: permissions.trust,
					trackBackground: (task, cancel) => {
						this.background.add(cancel);
						return this.track(task.finally(() => this.background.delete(cancel)));
					},
				}, manager, initial.event, initial.models, this.modelScope);
				if (this.disposed) { await runtime.dispose(); return; }
				this.current = runtime;
				await this.bindSession();
			} finally { this.changing = false; this.publish(); }
		};
		return this.track(client ? this.origin.run(client, initialize) : initialize());
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		try {
			const records = await this.history.load(runtime.cwd);
			const messages = session.messages.flatMap((message) => message.role === "user" ? [{
				timestamp: message.timestamp,
				text: typeof message.content === "string" ? message.content : message.content
					.filter((content) => content.type === "text").map((content) => content.text).join("\n"),
			}] : []);
			this.historyTexts = buildInitialHistory(records, messages, session.sessionId);
		} catch (error) { this.historyError(error); }
		this.unsubscribe = session.subscribe((event) => {
			this.messageTiming.accept(event);
			if (event.type === "message_start" && event.message.role === "user") this.submitted();
			if (event.type === "message_update") {
				if (this.observed) this.emit({ type: "stream", sessionId: session.sessionId, value: this.payloads.stream(event.message) });
				return;
			}
			if (event.type === "tool_execution_start" || event.type === "tool_execution_update") this.liveTools.set(event.toolCallId, {
				toolCallId: event.toolCallId, toolName: event.toolName, args: structuredClone(event.args), status: "running",
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
				output: event.type === "tool_execution_update" ? this.payloads.progress(event.toolCallId, event.toolName, structuredClone(event.partialResult)) : undefined,
			});
			if (event.type === "tool_execution_end") {
				// 变更 diff 作为界面专用条目落盘，父结果完成后仍可恢复。
				const mutation = event.parentToolCallId && !event.isError
					? nestedMutation(event.parentToolCallId, event.toolCallId, event.toolName, event.result) : undefined;
				if (mutation) session.sessionManager.appendCustomEntry(NESTED_MUTATION_ENTRY, mutation);
				const started = this.liveTools.get(event.toolCallId);
				if (event.parentToolCallId && started) this.liveTools.set(event.toolCallId, {
					...started, status: event.isError ? "error" : "ok",
					output: mutation ? this.payloads.complete(event.toolCallId, event.toolName, { content: [], details: { diff: mutation.diff } })
						: event.isError ? this.payloads.complete(event.toolCallId, event.toolName, structuredClone(event.result)) : undefined,
				});
				else {
					this.liveTools.delete(event.toolCallId);
					for (const [id, child] of this.liveTools) {
						if (child.parentToolCallId === event.toolCallId || child.parentToolCallId?.startsWith(`${event.toolCallId}/`)) this.liveTools.delete(id);
					}
				}
			}
			if (event.type === "agent_end" || event.type === "session_info_changed") this.refreshSessions();
			this.schedule();
		});
		const client = () => {
			const value = this.origin.getStore();
			if (!value) throw new Error("会话导航缺少发起客户端。");
			return value;
		};
		await session.bindExtensions({
			mode: "print",
			uiContext: this.dialogs.context(),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => client().newSession(options),
				fork: (entryId, options) => client().fork(entryId, options),
				navigateTree: (entryId, options) => session.navigateTree(entryId, options),
				switchSession: (file, options) => client().switchSession(file, options),
				reload: () => session.reload(),
			},
			shutdownHandler: () => this.emit({ type: "close" }),
			onError: (error) => this.dialogs.notify(`${error.extensionPath}: ${error.error}`, "error"),
		});
		this.refreshSessions();
	}

	snapshot(): GuiSnapshot {
		if (!this.toolController) throw new Error("工具选择未绑定。");
		return collectGuiSnapshot(this.runtime, {
			scopedModels: this.modelScope.ids,
			canSubmit: !this.changing,
			canChangeSession: !this.changing && this.idle,
			commandRunning: this.preparing > 0,
			liveTools: [...this.liveTools.values()], messageDurations: { ...this.messageTiming.durations },
			history: this.historyTexts, bashOutput: this.bashOutput,
		}, this.guiHistory, this.payloads, this.toolController, this.mcpTools?.list(this.runtime.session.getActiveToolNames()) ?? []);
	}
	private schedule(): void {
		if (!this.timer && !this.disposed) this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 0);
	}
	private scheduleReports(): void {
		if (!this.disposed && !this.changing && this.current && this.observed)
			this.reports.schedule(this.current.session, this.liveTools.size);
	}
	publish(): void {
		if (this.disposed) return;
		this.changed();
		if (this.observed) {
			this.emit({ type: "snapshot", value: this.current ? this.snapshot() : null });
			this.scheduleReports();
		}
	}

	/** 联网刷新模型目录：未中断则推新快照，provider 级失败合并成一条 notice。 */
	refreshModelCatalog(signal: AbortSignal): Promise<void> {
		const refresh = async () => {
			const { aborted, errors } = await this.runtime.services.modelRuntime.refresh({ signal });
			if (aborted) return;
			this.publish();
			if (errors.size)
				this.dialogs.notify(`模型列表刷新失败，已使用缓存: ${[...errors.keys()].join(", ")}`, "warning");
		};
		return this.track(refresh());
	}

	dispatch(action: GuiAction, client: SessionClient): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("会话实例已释放。"));
		return this.track(this.origin.run(client, () => this.perform(action, client)));
	}
	query<Q extends SessionQuery>(query: Q): Promise<GuiQueryResults[Q["query"]]>;
	query(query: SessionQuery): Promise<GuiQueryResults[SessionQuery["query"]]> {
		if (this.disposed) return Promise.reject(new Error("会话实例已释放。"));
		return this.track(this.readQuery(query));
	}
	private async readQuery(query: SessionQuery): Promise<GuiQueryResults[SessionQuery["query"]]> {
		if (query.query === "image") return this.payloads.image(query.id);
		if (query.query === "toolOutput") return this.payloads.toolOutput(query.id);
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const runtime = this.runtime;
		switch (query.query) {
			case "complete": return completeCommand(runtime.session, query.text);
			case "files": return completeFiles(runtime.cwd, query.prefix);
			case "config": await runtime.services.settingsManager.flush(); return readConfig(query.file);
		}
	}

	private async perform(action: GuiAction, client: SessionClient): Promise<void> {
		switch (action.action) {
			case "dialog": this.dialogs.respond(action.id, action.value); return;
			case "clearNotices": this.dialogs.clearNotices(action.ids); return;
			case "draft": client.writeDraft(action.text); return;
			case "cancelLogin": this.loginController?.abort(); if (this.mcpLoggingIn) this.dialogs.cancel(); return;
			case "abort":
				this.dialogs.cancel();
				this.commandController.abort();
				this.commandController = new AbortController();
				this.loginController?.abort();
				if (this.current) {
					const session = this.current.session;
					session.abortBash();
					await session.abort();
				}
				this.publish(); return;
		}
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const { session, services } = this.runtime;
		switch (action.action) {
			case "view": await openView(this, action.view, this.commandController.signal); return;
			case "prompt": await this.prompt(action, client); return;
			case "clearQueue": session.clearQueue(); this.publish(); return;
			case "export": await exportSession(session, action.format, (event) => this.emit(event)); return;
			case "login":
				if (this.loginController) throw new Error("已有登录流程正在进行。");
				this.loginController = new AbortController();
				this.publish();
				this.emit({ type: "auth", value: { type: "progress", message: "正在准备登录…" } });
				try { await runLogin(services.modelRuntime, action.provider, action.type, this.dialogs, (event) => this.emit(event), this.loginController.signal, () => services.settingsManager.getOrCreateDeviceId()); }
				catch (error) { if (!this.loginController.signal.aborted) throw error; }
				finally { this.loginController = undefined; this.emit({ type: "auth", value: null }); this.publish(); }
				return;
			case "logout": try { await services.modelRuntime.logout(action.provider); } finally { this.publish(); } return;
			case "compact":
				if (session.isCompacting) throw new Error("压缩已在进行。");
				try { await session.compact(action.instructions || undefined); } finally { this.publish(); } return;
		}
		await this.change(() => this.mutate(action));
	}

	async change<T>(operation: () => Promise<T>): Promise<T> {
		if (this.changing || !this.idle) throw new Error("请先停止或等待当前操作结束。");
		this.changing = true;
		this.reports.invalidate();
		this.publish();
		try { return await operation(); } finally { this.changing = false; this.publish(); }
	}

	private async prompt(action: Extract<GuiAction, { action: "prompt" }>, client: SessionClient): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		const text = normalizeHistoryText(action.text);
		if (text) {
			this.historyTexts = [...this.historyTexts.filter((entry) => entry !== text), text].slice(-100);
			void this.history.append({ cwd: runtime.cwd, session: session.sessionId, text }).catch((error: unknown) => this.historyError(error));
		}
		this.publish();
		if (await runBuiltin(this, action.text, (next) => client.dispatch(next))) return;
		this.preparing++;
		const mcpLogin = /^\/mcp\s+login(?:\s|$)/.test(action.text);
		if (mcpLogin) this.mcpLoggingIn = true;
		this.publish();
		try {
			if (action.text.startsWith("!")) {
				this.submitted();
				await session.executeBash(action.text.replace(/^!!?/, ""), (chunk) => {
					this.bashOutput = (this.bashOutput + chunk).slice(-64_000);
					this.schedule();
				}, { excludeFromContext: action.text.startsWith("!!") });
			} else {
				const attachments = await expandAttachments(action.text, runtime.cwd);
				await session.prompt(attachments.text, {
					images: [...attachments.images, ...action.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }))],
					streamingBehavior: action.behavior, source: "interactive",
				});
			}
		} finally {
			if (mcpLogin) { this.mcpLoggingIn = false; this.emit({ type: "auth", value: null }); }
			this.bashOutput = "";
			this.preparing--;
			this.refreshSessions();
			this.publish();
		}
	}

	private async mutate(action: GuiAction): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		switch (action.action) {
			case "navigate": {
				const result = await session.navigateTree(action.entryId, { summarize: action.summarize });
				if (result.editorText) this.dialogs.context().setEditorText(result.editorText);
				break;
			}
			case "label": session.sessionManager.appendLabelChange(action.entryId, action.label); break;
			case "rename": session.setSessionName(action.name); this.refreshSessions(); break;
			case "reload": await session.reload(); break;
			case "model": {
				const model = runtime.services.modelRuntime.getModel(action.provider, action.id);
				if (!model) throw new Error("模型不存在。");
				await session.setModel(model, { persist: false }); break;
			}
			case "thinking": session.setThinkingLevel(action.level); break;
			case "scopeModels": this.modelScope.set(runtime, action.models); break;
			case "persistModels": await this.modelScope.persist(runtime); break;
			case "persistDefaultModel": await persistDefaultModel(runtime); break;
			case "settings":
				session.setAutoCompactionEnabled(action.compaction); session.setAutoRetryEnabled(action.retry);
				session.setSteeringMode(action.steering); session.setFollowUpMode(action.followUp);
				runtime.services.settingsManager.setImageAutoResize(action.autoResize); runtime.services.settingsManager.setBlockImages(action.blockImages);
				await runtime.services.settingsManager.flush(); break;
			case "tool":
			case "persistTools":
				if (!this.toolController) throw new Error("工具选择未绑定。");
				if (action.action === "tool") {
					if (!this.mcpTools?.set(action.name, action.enabled)) this.toolController.set(action.name, action.enabled);
				}
				else this.dialogs.notify(`已保存: ${await this.toolController.persistUserDefaults()}`);
				break;
			case "saveConfig":
				await runtime.services.settingsManager.flush(); await saveConfig(action.file, action.original, action.content);
				await session.reload(); break;
			default: throw new Error("非会话操作。");
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
		const infoClosed = this.reports.dispose();
		for (const cancel of this.background) cancel();
		clearTimeout(this.timer);
		this.loginController?.abort(); this.commandController.abort(); this.dialogs.cancel();
		if (this.current) {
			this.current.session.abortBash();
			await this.current.session.abort();
		}
		await Promise.allSettled([...this.tasks]);
		this.unsubscribe?.();
		if (this.current) { await this.current.services.settingsManager.flush(); await this.current.dispose(); }
		await this.history.flush();
		await infoClosed;
	}
}
