import type { SessionManager, AgentSessionRuntime, SessionStartEvent, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UserHistoryStore, buildInitialHistory, normalizeHistoryText } from "../../../harness/user-history.ts";
import type { ToolSelectionController } from "../../../harness/tool-defaults/controller.ts";
import type { GuiAction, GuiActionResult, SessionAction, SessionMutation } from "../../shared/protocol/actions.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import type { SessionQuery, GuiQueryResults } from "../../shared/protocol/queries.ts";
import type { GuiSnapshot } from "../../shared/protocol/state.ts";
import type { ApprovalStores, SessionApprovalRules } from "../../../harness/approval/rules/store.ts";
import { GuiExecutionContext } from "./execution-context.ts";
import { createGuiRuntime } from "./runtime.ts";
import { exportSession, readConfig, saveConfig } from "./files.ts";
import { runLogin } from "./login.ts";
import { builtinCommands, completeCommand, runBuiltin } from "./commands.ts";
import { openView, consumeUsageCredit } from "./views.ts";
import { collectGuiSnapshot } from "../projection/snapshot.ts";
import { persistDefaultModel } from "./models.ts";
import { GuiPayloads } from "../projection/payloads.ts";
import { GuiHistory } from "../projection/history.ts";
import { GuiStream } from "../projection/stream.ts";
import { GuiLiveTools } from "../projection/live-tools.ts";
import { NESTED_MUTATION_ENTRY } from "../projection/nested-mutations.ts";
import type { GuiMcpTools } from "./mcp-tools.ts";
import { setCodexSpeed } from "../../../harness/codex-speed/state.ts";
import { applyToolPreset } from "../../../harness/tool-defaults/presets.ts";
import { heicHints } from "../../../harness/media/heic.ts";
import { workspaceExists } from "../catalog/workspaces.ts";

export interface SessionClient extends Pick<ExtensionCommandContext, "newSession" | "fork" | "switchSession"> {
	emit(event: GuiEvent): void;
	readDraft(): string;
	writeDraft(text: string): void;
	dispatch<A extends GuiAction>(action: A): Promise<GuiActionResult<A>>;
}
type Listener = (event: GuiEvent) => void;
const liveMutations = new Set<SessionMutation["action"]>([
	"model", "thinking", "codexSpeed", "scopeModels", "persistModels", "persistDefaultModel",
	"tool", "toolPreset", "mcpServers", "persistTools", "label", "rename",
]);

/** 可整体释放的 SDK 执行资源。导航和会话身份由 GuiSession 持有。 */
export class GuiExecution {
	private history = new UserHistoryStore();
	private historyTexts: string[] = [];
	private historyWarned = false;
	private observed = false;
	private unsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private changing = false;
	private preparing = 0;
	readonly payloads = new GuiPayloads();
	private guiHistory = new GuiHistory(this.payloads);
	private stream = new GuiStream(this.payloads);
	private bashCommand: string | null = null;
	private bashOutput = "";
	private liveTools = new GuiLiveTools(this.payloads);
	private disposed = false;
	private tasks = new Set<Promise<unknown>>();
	private loginController: AbortController | undefined;
	private mcpLoggingIn = false;
	readonly dialogs;
	readonly usageService;
	readonly modelScope;

	private constructor(readonly runtime: AgentSessionRuntime, private context: GuiExecutionContext,
		private toolset: { controller: ToolSelectionController }, private mcp: { tools: GuiMcpTools | null }) {
		this.dialogs = context.dialogs;
		this.usageService = context.usageService;
		this.modelScope = context.modelScope;
		context.tail = () => runtime.session.messages.length + (runtime.session.state.streamingMessage ? 1 : 0);
		context.publish = () => this.schedule();
	}
	get id(): string { return this.context.id; }
	get titleGeneration() { return this.context.titleGeneration; }
	get idle(): boolean {
		return (this.runtime.session.isIdle && !this.runtime.session.isBashRunning)
			&& !this.loginController && this.preparing === 0;
	}
	get canRelease(): boolean {
		return !this.changing && this.idle && this.tasks.size === 0 && this.dialogs.list().length === 0
			&& this.runtime.session.getSteeringMessages().length === 0 && this.runtime.session.getFollowUpMessages().length === 0;
	}
	get running(): boolean { return !this.idle; }

	emit(event: GuiEvent): void { this.context.emit(event); }
	observe(value: boolean): void {
		if (value === this.observed) return;
		this.observed = value;
		if (value) this.scheduleReports(); else this.context.reports.invalidate();
	}

	replay(listener: Listener): void {
		listener({ type: "dialogs", value: this.dialogs.list() });
		listener({ type: "notices", value: [...this.dialogs.notices] });
		listener({ type: "snapshot", value: this.snapshot() });
		this.context.reports.replay(listener);
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.tasks.add(task);
		return task.finally(() => { this.tasks.delete(task); this.context.changed(); });
	}

	static create(context: GuiExecutionContext, manager: SessionManager,
		permissions: { stores: ApprovalStores; rules: SessionApprovalRules; trust: Map<string, boolean> },
		client: SessionClient | undefined, initial: { event: SessionStartEvent; models: string[] | undefined }): Promise<GuiExecution> {
		const initialize = async () => {
			let selection: { controller: ToolSelectionController } | undefined;
			const mcp: { tools: GuiMcpTools | null } = { tools: null };
			const runtime = await createGuiRuntime(manager.getCwd(), {
				dialogs: context.dialogs,
				emit: (event) => context.emit(event),
				bindTools: (controller) => {
					if (selection) selection.controller = controller;
					else selection = { controller };
				},
				bindMcp: (tools) => { mcp.tools = tools; },
				bindModelServices: (config) => context.modelServices.bind(config),
				toolsChanged: () => context.publish(),
				commandSignal: () => context.commandController.signal,
				reports: context.reports, usageService: context.usageService,
				approvalStores: permissions.stores, approvalRules: permissions.rules, projectTrust: permissions.trust,
				bindAutoTitle: (generate) => { context.autoTitle = generate; },
				titleGenerationChanged: (state) => { context.titleGeneration = state; context.publish(); },
				signal: context.lifetime.signal,
			}, manager, initial.event, initial.models, context.modelScope);
			if (!selection) {
				await runtime.dispose();
				throw new Error("工具选择扩展未完成装配。");
			}
			const execution = new GuiExecution(runtime, context, selection, mcp);
			try {
				if (!context.lifetime.signal.aborted) await execution.bindSession();
				return execution;
			} catch (error) { await execution.dispose(); throw error; }
		};
		return client ? context.origin.run(client, initialize) : initialize();
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
			if (event.type === "message_start") this.stream.start(event.message);
			if (event.type === "message_end") {
				this.stream.end();
				if (event.message.role === "toolResult") this.liveTools.settle(event.message.toolCallId);
			}
			if (event.type === "message_start" && event.message.role === "user") this.context.submitted();
			if (event.type === "message_update") {
				const update = event.assistantMessageEvent;
				if (!("contentIndex" in update)) throw new Error("SDK message_update 缺少内容块。");
				const appendOnly = this.stream.update(update);
				if (this.observed) this.emit({ type: "stream", sessionId: session.sessionId, value: this.stream.project(), appendOnly });
				return;
			}
			if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
				const mutation = this.liveTools.accept(event);
				// 变更 diff 作为界面专用条目落盘，父结果完成后仍可恢复。
				if (mutation) session.sessionManager.appendCustomEntry(NESTED_MUTATION_ENTRY, mutation);
			}
			if (event.type === "agent_end" || event.type === "session_info_changed") this.context.refreshSessions();
			this.schedule();
		});
		const client = () => {
			const value = this.context.origin.getStore();
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
				reload: () => this.reload(),
			},
			shutdownHandler: () => this.emit({ type: "close" }),
			onError: (error) => this.dialogs.notify(`${error.extensionPath}: ${error.error}`, "error"),
		});
		this.context.refreshSessions();
	}

	snapshot(): GuiSnapshot {
		return collectGuiSnapshot(this.runtime, {
			titleGeneration: this.titleGeneration,
			scopedModels: this.modelScope.ids,
			modelScopeChanged: this.modelScope.hasDefaultChanges(this.runtime),
			modelServicesRevision: this.context.modelServices.revision,
			canSubmit: !this.changing,
			canChangeSession: !this.changing && this.idle,
			commandRunning: this.preparing > 0,
			liveTools: this.liveTools.project(),
			history: this.historyTexts, bashCommand: this.bashCommand, bashOutput: this.bashOutput, streamingMessage: this.stream.project(),
		}, this.guiHistory, this.toolset.controller, this.mcp.tools === null ? [] : this.mcp.tools.list(this.runtime.session.getActiveToolNames()));
	}
	private schedule(): void {
		if (!this.timer && !this.disposed) this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 0);
	}
	private scheduleReports(): void {
		if (!this.disposed && !this.changing && this.observed)
			this.context.reports.schedule(this.runtime.session, this.liveTools.size);
	}
	publish(): void {
		if (this.disposed) return;
		this.context.changed();
		if (this.observed) {
			this.emit({ type: "snapshot", value: this.snapshot() });
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

	async generateTitle(client: SessionClient): Promise<void> {
		if (this.disposed || this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const generate = this.context.autoTitle;
		if (!generate) throw new Error("Auto-title configuration is unavailable.");
		await this.track(this.context.origin.run(client, generate));
	}

	dispatch<A extends SessionAction>(action: A, client: SessionClient): Promise<GuiActionResult<A>>;
	dispatch(action: SessionAction, client: SessionClient): Promise<GuiActionResult> {
		if (this.disposed) return Promise.reject(new Error("会话实例已释放。"));
		return this.track(this.context.origin.run(client, () => this.perform(action, client)));
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
			case "modelServiceCatalog": return this.context.modelServices.read(runtime.services.modelRuntime, query.provider, this.context.commandController.signal);
			case "complete": return completeCommand(runtime.session, query.text);
			case "config": await runtime.services.settingsManager.flush(); return readConfig(query.file);
		}
	}

	private async perform(action: SessionAction, client: SessionClient): Promise<GuiActionResult> {
		switch (action.action) {
			case "dialog": this.dialogs.respond(action.id, action.value); return;
			case "clearNotices": this.dialogs.clearNotices(action.ids); return;
			case "cancelLogin": this.loginController?.abort(); if (this.mcpLoggingIn) this.dialogs.cancel(); return;
			case "abort":
				if (this.runtime.session.isCompacting) {
					this.runtime.session.abortCompaction();
					this.runtime.session.abortBranchSummary();
					return;
				}
				const { steering, followUp } = this.runtime.session.clearQueue();
				const text = [...steering, ...followUp].join("\n\n");
				if (text) this.emit({ type: "editor", sessionId: this.id, text, mode: "prepend" });
				this.context.cancel();
				this.loginController?.abort();
				this.runtime.session.abortBash();
				await this.runtime.session.abort();
				this.publish(); return;
		}
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const { session, services } = this.runtime;
		switch (action.action) {
			case "view": await openView(this, action, this.context.commandController.signal); return;
			case "consumeCodexCredit": return consumeUsageCredit(this, action, this.context.commandController.signal);
			case "prompt": await this.prompt(action, client); return;
			case "clearQueue": session.clearQueue(); this.publish(); return;
			case "export": await exportSession(session, action.format, (event) => this.emit(event)); return;
			case "login":
				if (this.loginController) throw new Error("已有登录流程正在进行。");
				this.loginController = new AbortController();
				this.publish();
				this.emit({ type: "auth", value: { type: "progress", message: "正在准备登录…" } });
				try { await runLogin(services.modelRuntime, action.provider, action.type, this.dialogs, (event) => this.emit(event), this.loginController, () => services.settingsManager.getOrCreateDeviceId()); }
				catch (error) {
					if (!this.loginController.signal.aborted || error !== this.loginController.signal.reason) throw error;
				}
				finally { this.loginController = undefined; this.emit({ type: "auth", value: null }); this.publish(); }
				return;
			case "logout": try { await services.modelRuntime.logout(action.provider); } finally { this.publish(); } return;
			case "compact":
				if (session.isCompacting) throw new Error("压缩已在进行。");
				try { await session.compact(action.instructions || undefined); } finally { this.publish(); } return;
		}
		await this.change(() => this.mutate(action), liveMutations.has(action.action));
	}

	async change<T>(operation: () => Promise<T>, allowRunning = false): Promise<T> {
		if (this.changing || !allowRunning && !this.idle) throw new Error("请先停止或等待当前操作结束。");
		this.changing = true;
		this.context.reports.invalidate();
		this.publish();
		try { return await operation(); } finally { this.changing = false; this.publish(); }
	}

	private async prompt(action: Extract<GuiAction, { action: "prompt" }>, client: SessionClient): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		if (action.files.length || action.images.length) {
			const builtinName = /^\/(\S+)/.exec(action.text.trim())?.[1];
			const sdkName = /^\/([^ ]+)/.exec(action.text)?.[1];
			const templateName = /^\/(\S+)/.exec(action.text)?.[1];
			if (action.text.startsWith("!")
				|| builtinCommands.some(({ name }) => name === builtinName)
				|| sdkName && (session.extensionRunner.getCommand(sdkName)
					|| runtime.services.resourceLoader.getSkills().skills.some(({ name }) => `skill:${name}` === sdkName))
				|| session.promptTemplates.some(({ name }) => name === templateName))
				throw new Error("命令不支持附件，请移除附件后再执行。");
		}
		if (!await workspaceExists(runtime.cwd)) throw new Error("工作目录不存在或不是文件夹，无法发送消息。");
		const text = normalizeHistoryText(action.text);
		if (text) {
			this.historyTexts = [...this.historyTexts.filter((entry) => entry !== text), text].slice(-100);
			void this.history.append({ cwd: runtime.cwd, session: session.sessionId, text }).catch((error: unknown) => this.historyError(error));
		}
		this.publish();
		if (await runBuiltin(this, action.text, async (next) => { await client.dispatch(next); })) return;
		this.preparing++;
		const mcpLogin = /^\/mcp\s+login(?:\s|$)/.test(action.text);
		if (mcpLogin) this.mcpLoggingIn = true;
		this.publish();
		try {
			if (action.text.startsWith("!")) {
				this.bashCommand = action.text.replace(/^!!?/, "");
				this.publish();
				this.context.submitted();
				await session.executeBash(this.bashCommand, (chunk) => {
					this.bashOutput = (this.bashOutput + chunk).slice(-64_000);
					this.schedule();
				}, { excludeFromContext: action.text.startsWith("!!") });
			} else {
				const files = action.files.filter((file) => file.text.length > 0).map((file) =>
					`<file name="${file.name}">\n${file.text.replace(/^\uFEFF/, "")}\n</file>\n`);
				const imageHints = action.images.flatMap((image) =>
					image.imageCount === undefined ? [] : heicHints(image.imageCount)).map((hint) => `${hint}\n`);
				await session.prompt([...files, ...imageHints, action.text].join(""), {
					images: action.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
					streamingBehavior: action.behavior,
				});
			}
		} finally {
			if (mcpLogin) { this.mcpLoggingIn = false; this.emit({ type: "auth", value: null }); }
			this.bashCommand = null;
			this.bashOutput = "";
			this.preparing--;
			this.context.refreshSessions();
			this.publish();
		}
	}

	private async reload(): Promise<void> {
		const { session, services: { modelRuntime } } = this.runtime;
		await session.reload({ beforeSessionStart: async () => {
			const result = await modelRuntime.refresh({ allowNetwork: false, signal: this.context.commandController.signal });
			if (result.aborted) throw new Error("模型配置重载已取消");
			if (result.errors.size) throw new Error("模型配置重载失败");
			const current = session.model;
			const model = current && modelRuntime.getModel(current.provider, current.id);
			// 同一模型只更新目录信息，不触发模型切换或追加会话记录。
			if (model) session.agent.state.model = model;
		} });
	}

	private async mutate(action: SessionMutation): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		switch (action.action) {
			case "navigate": {
				const result = await session.navigateTree(action.entryId, { summarize: action.summarize });
				if (result.editorText) this.dialogs.context().setEditorText(result.editorText);
				return;
			}
			case "label": session.sessionManager.appendLabelChange(action.entryId, action.label); return;
			case "rename": session.setSessionName(action.name); this.context.refreshSessions(); return;
			case "reload": await this.reload(); return;
			case "model": {
				const model = runtime.services.modelRuntime.getModel(action.provider, action.id);
				if (!model) throw new Error("模型不存在。");
				await session.setModel(model, { persist: false }); return;
			}
			case "thinking": session.setThinkingLevel(action.level); return;
			case "codexSpeed":
				setCodexSpeed(session.model?.provider, action.speed, session.sessionManager.getBranch(),
					(type, data) => session.sessionManager.appendCustomEntry(type, data));
				return;
			case "scopeModels": this.modelScope.set(runtime, action.models); return;
			case "persistModels": await this.modelScope.persist(runtime); return;
			case "persistDefaultModel": await persistDefaultModel(runtime); return;
			case "settings":
				session.setAutoCompactionEnabled(action.compaction); session.setAutoRetryEnabled(action.retry);
				session.setSteeringMode(action.steering); session.setFollowUpMode(action.followUp);
				runtime.services.settingsManager.setImageAutoResize(action.autoResize); runtime.services.settingsManager.setBlockImages(action.blockImages);
				session.setCacheWarmingMode(action.cacheWarming);
				await runtime.services.settingsManager.flush(); return;
			case "mcpServers":
				if (this.mcp.tools === null) throw new Error("MCP 已禁用。");
				this.mcp.tools.setServers(action.names, action.enabled);
				return;
			case "tool":
				if (this.mcp.tools === null || !this.mcp.tools.set(action.name, action.enabled)) this.toolset.controller.set(action.name, action.enabled);
				return;
			case "toolPreset": {
				const mcpNames = new Set(this.mcp.tools === null ? [] : this.mcp.tools.list(session.getActiveToolNames()).map((tool) => tool.name));
				applyToolPreset(session, this.toolset.controller, action.preset, mcpNames);
				return;
			}
			case "persistTools":
				await this.toolset.controller.persistUserDefaults();
				await runtime.services.settingsManager.reload(); return;
			case "saveConfig":
				await runtime.services.settingsManager.flush(); await saveConfig(action.file, action.original, action.content);
				await this.reload(); return;
		}
		action satisfies never;
	}
	private historyError(error: unknown): void {
		if (this.historyWarned) return;
		this.historyWarned = true;
		this.dialogs.notify(`输入历史不可用: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const infoClosed = this.context.reports.dispose();
		this.context.close();
		clearTimeout(this.timer);
		this.loginController?.abort();
		this.runtime.session.abortBash();
		// SDK 负责中止工具、关闭扩展和等待凭据写入，同时排空宿主任务。
		await Promise.all([this.runtime.dispose(), Promise.allSettled([...this.tasks])]);
		this.unsubscribe?.();
		await this.runtime.services.settingsManager.flush();
		await this.history.flush();
		await infoClosed;
	}
}
