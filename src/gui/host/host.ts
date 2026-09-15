import path from "node:path";
import { stat } from "node:fs/promises";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { UserHistoryStore, buildInitialHistory } from "../../harness/user-history.ts";
import { compileSchemaValidator } from "../../harness/schema-validator.ts";
import type { ToolSelectionController } from "../../harness/tool-defaults/controller.ts";
import { actionSchema, type GuiAction, type GuiEvent, type GuiSnapshot } from "../contract.ts";
import { GuiDialogs } from "./dialogs.ts";
import { createGuiRuntime } from "./runtime.ts";
import { exportSession, importSession, completeFiles, expandAttachments, readConfig, saveConfig } from "./files.ts";
import { runLogin } from "./login.ts";
import { runBuiltin } from "./commands.ts";
import { collectGuiSnapshot } from "./snapshot.ts";
import { persistModelScope, setModelScope } from "./models.ts";
import { GuiSessionCatalog } from "./sessions.ts";
import { filterSessionTreeNoTools } from "./session-tree.ts";
import { prepareHistoryDeletion, type DeleteHistoryAction } from "./delete-history.ts";

const validate = compileSchemaValidator(actionSchema);

/** 图形宿主仅负责生命周期、交互和边界校验。业务状态始终从 SDK 读取。 */
export class GuiHost {
	private current: AgentSessionRuntime | undefined;
	private history = new UserHistoryStore();
	private historyTexts: string[] = [];
	private historyWarned = false;
	private listeners = new Set<(event: GuiEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private changing = false;
	private preparing = 0;
	private commandController = new AbortController();
	private liveTools = new Map<string, GuiSnapshot["liveTools"][number]>();
	private disposed = false;
	private tasks = new Set<Promise<unknown>>();
	private toolController: ToolSelectionController | undefined;
	private loginController: AbortController | undefined;
	private sessions = new GuiSessionCatalog((value) => this.emit({ type: "sessions", value }));
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
		listener({ type: "dialogs", value: this.dialogs.list() });
		for (const value of this.dialogs.notices) listener({ type: "notice", value });
		listener({ type: "snapshot", value: this.current ? this.snapshot() : null });
		if (this.sessions.value) listener({ type: "sessions", value: this.sessions.value });
		return () => this.listeners.delete(listener);
	}

	start(cwd: string): Promise<void> {
		const task = this.initialize(cwd);
		this.tasks.add(task);
		return task.finally(() => this.tasks.delete(task));
	}

	private async initialize(cwd: string, sessionManager?: SessionManager): Promise<void> {
		this.changing = true;
		try {
			const runtime = await createGuiRuntime(
				cwd,
				this.dialogs,
				(event) => this.emit(event),
				(controller) => {
					this.toolController = controller;
				},
				() => this.commandController.signal,
				sessionManager,
			);
			if (this.disposed) {
				await runtime.dispose();
				return;
			}
			this.current = runtime;
			this.current.setBeforeSessionInvalidate(() => {
				this.unsubscribe?.();
				this.toolController = undefined;
				this.liveTools.clear();
				this.dialogs.cancel();
			});
			this.current.setRebindSession(() => this.bindSession());
			await this.bindSession();
		} finally {
			this.changing = false;
			this.publish();
		}
	}

	private async bindSession(): Promise<void> {
		const runtime = this.runtime;
		const session = runtime.session;
		this.historyWarned = false;
		try {
			const records = await this.history.load(runtime.cwd);
			const messages = session.messages.flatMap((message) =>
				message.role === "user"
					? [
							{
								timestamp: message.timestamp,
								text:
									typeof message.content === "string"
										? message.content
										: message.content
												.filter((content) => content.type === "text")
												.map((content) => content.text)
												.join("\n"),
							},
						]
					: [],
			);
			this.historyTexts = buildInitialHistory(records, messages, session.sessionId);
		} catch (error) {
			this.historyTexts = [];
			this.historyError(error);
		}
		this.unsubscribe?.();
		this.unsubscribe = session.subscribe((event) => {
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

	snapshot(): GuiSnapshot {
		return collectGuiSnapshot(this.runtime, {
			busy: this.changing,
			commandRunning: this.preparing > 0,
			liveTools: [...this.liveTools.values()],
			history: this.historyTexts,
			dialogs: this.dialogs.list(),
			notices: [...this.dialogs.notices],
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

	publish(): void {
		if (!this.disposed) this.emit({ type: "snapshot", value: this.current ? this.snapshot() : null });
	}

	async dispatch(value: unknown): Promise<void> {
		if (!validate(value)) throw new Error("无效 GUI 操作参数。");
		const action = value as GuiAction;
		if (this.disposed) throw new Error("宿主已关闭。");
		if (action.action === "dialog") {
			this.dialogs.respond(action.id, action.value);
			return;
		}
		if (action.action === "draft") {
			this.dialogs.draft = action.text;
			return;
		}
		if (action.action === "cancelLogin") {
			this.loginController?.abort();
			return;
		}
		if (action.action === "abort") {
			this.dialogs.cancel();
			this.commandController.abort();
			this.commandController = new AbortController();
			this.loginController?.abort();
			if (this.current) {
				this.current.session.abortBash();
				this.current.session.abortCompaction();
				this.current.session.abortBranchSummary();
				this.current.session.abortRetry();
				await this.current.session.abort();
			}
			this.publish();
			return;
		}
		if (action.action === "sessions") {
			await this.sessions.refresh();
			return;
		}
		if (this.changing) throw new Error("正在处理会话操作，请稍后再试。");
		const task =
			action.action === "deleteSession" || action.action === "deleteWorkspace"
				? this.deleteHistory(action)
				: this.execute(action);
		this.tasks.add(task);
		try {
			await task;
		} finally {
			this.tasks.delete(task);
			this.publish();
		}
	}

	private async deleteHistory(action: DeleteHistoryAction): Promise<void> {
		this.assertIdle();
		if (this.dialogs.list().length) throw new Error("请先完成或取消当前对话框。");
		this.changing = true;
		this.publish();
		try {
			const plan = await prepareHistoryDeletion(action, this.current ? this.snapshot() : undefined);
			if ((await this.dialogs.ask("confirm", plan.title, plan.message)) !== "yes" || this.disposed) return;
			await plan.verify();
			if (plan.affectsCurrent && this.current) {
				if (action.action === "deleteWorkspace") {
					await this.current.dispose();
					this.current = undefined;
					this.historyTexts = [];
					for (const key of Object.keys(this.dialogs.status)) delete this.dialogs.status[key];
				} else if ((await this.current.newSession()).cancelled) {
					this.dialogs.notify("会话切换被取消，未删除历史。");
					return;
				}
				this.dialogs.context().setEditorText("");
			}
			await plan.remove();
		} finally {
			this.changing = false;
			await this.sessions.refresh();
		}
	}

	private assertIdle(): void {
		if (
			(this.current && (!this.current.session.isIdle || this.current.session.isBashRunning)) ||
			this.loginController ||
			this.preparing > 0
		)
			throw new Error("请先停止或等待当前操作结束。");
	}

	private async execute(action: Exclude<GuiAction, { action: "dialog" | "draft" }>): Promise<void> {
		if (!this.current) {
			this.changing = true;
			try {
				if (action.action === "workspace") await this.initialize(action.path);
				else if (action.action === "switch") {
					if (!(await stat(action.path)).isFile()) throw new Error("会话路径不是文件。");
					const manager = SessionManager.open(action.path);
					await this.initialize(manager.getCwd(), manager);
				} else throw new Error("请先选择工作区。");
			} finally {
				this.changing = false;
			}
			return;
		}
		const runtime = this.runtime;
		const session = runtime.session;
		switch (action.action) {
			case "prompt": {
				if (action.text.trim()) {
					this.historyTexts = [...this.historyTexts, action.text.trim()].slice(-100);
					void this.history
						.append({ cwd: runtime.cwd, session: session.sessionId, text: action.text })
						.catch((error: unknown) => this.historyError(error));
				}
				if (await runBuiltin(this, action.text)) return;
				if (action.text.startsWith("!")) {
					await session.executeBash(
						action.text.replace(/^!!?/, ""),
						(chunk) => {
							this.dialogs.status["bash"] = ((this.dialogs.status["bash"] ?? "") + chunk).slice(-64_000);
							this.schedule();
						},
						{ excludeFromContext: action.text.startsWith("!!") },
					);
					delete this.dialogs.status["bash"];
					this.refreshSessions();
					return;
				}
				const name = session.sessionName;
				this.preparing++;
				this.publish();
				try {
					const attachments = await expandAttachments(action.text, runtime.cwd);
					await session.prompt(attachments.text, {
						images: [
							...attachments.images,
							...action.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
						],
						streamingBehavior: action.behavior,
						source: "interactive",
					});
				} finally {
					this.preparing--;
					if (session.sessionName !== name) this.refreshSessions();
				}
				return;
			}
			case "complete": {
				const match = /^\/(\S+)\s(.*)$/s.exec(action.text);
				const command = match?.[1] ? session.extensionRunner.getCommand(match[1]) : undefined;
				const items = await command?.getArgumentCompletions?.(match?.[2] ?? "");
				this.emit({
					type: "completions",
					text: action.text,
					items: items?.map(({ value, label }) => ({ value, label })) ?? [],
				});
				return;
			}
			case "files":
				this.emit({ type: "files", paths: await completeFiles(runtime.cwd, action.prefix) });
				return;
			case "tree":
				this.emit({
					type: "panel",
					title: "会话树",
					value: filterSessionTreeNoTools(session.sessionManager.getTree(), session.sessionManager.getLeafId()),
				});
				return;
			case "clearQueue":
				session.clearQueue();
				return;
			case "login": {
				if (this.loginController) throw new Error("已有登录流程正在进行。");
				this.loginController = new AbortController();
				try {
					await runLogin(
						runtime.services.modelRuntime,
						action.provider,
						action.type,
						this.dialogs,
						(event) => this.emit(event),
						this.loginController.signal,
					);
				} finally {
					this.loginController = undefined;
				}
				return;
			}
			case "logout":
				await runtime.services.modelRuntime.logout(action.provider);
				return;
			case "compact":
				if (session.isCompacting) throw new Error("压缩已在进行。");
				await session.compact(action.instructions || undefined);
				return;
			case "config":
				await runtime.services.settingsManager.flush();
				this.emit({ type: "config", file: action.file, content: await readConfig(action.file) });
				return;
			case "export":
				await exportSession(session, action.format, (event) => this.emit(event));
				return;
		}
		this.assertIdle();
		this.changing = true;
		this.publish();
		try {
			switch (action.action) {
				case "new":
					await runtime.newSession();
					break;
				case "workspace": {
					const cwd = path.resolve(runtime.cwd, action.path);
					if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
					await runtime.dispose();
					this.current = undefined;
					await this.start(cwd);
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
				case "label":
					session.sessionManager.appendLabelChange(action.entryId, action.label);
					break;
				case "rename":
					session.setSessionName(action.name);
					this.refreshSessions();
					break;
				case "import":
					await importSession(runtime, action.content);
					break;
				case "reload":
					this.toolController = undefined;
					await session.reload();
					break;
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
				case "scopeModels":
					setModelScope(runtime, action.models);
					break;
				case "persistModels":
					await persistModelScope(runtime);
					break;
				case "settings": {
					session.setAutoCompactionEnabled(action.compaction);
					session.setAutoRetryEnabled(action.retry);
					session.setSteeringMode(action.steering);
					session.setFollowUpMode(action.followUp);
					runtime.services.settingsManager.setImageAutoResize(action.autoResize);
					runtime.services.settingsManager.setBlockImages(action.blockImages);
					await runtime.services.settingsManager.flush();
					break;
				}
				case "tool":
				case "persistTools": {
					if (!this.toolController) await session.prompt("/tools");
					if (!this.toolController) throw new Error("工具选择未绑定。");
					if (action.action === "tool") this.toolController.set(action.name, action.enabled);
					else this.dialogs.notify(`已保存: ${await this.toolController.persistUserDefaults()}`);
					break;
				}
				case "saveConfig":
					await runtime.services.settingsManager.flush();
					await saveConfig(action.file, action.original, action.content);
					await session.reload();
					break;
			}
		} finally {
			this.changing = false;
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
		clearTimeout(this.timer);
		this.loginController?.abort();
		this.commandController.abort();
		this.dialogs.cancel();
		if (this.current) {
			this.current.session.abortBash();
			await this.current.session.abort();
		}
		await Promise.allSettled([...this.tasks]);
		this.unsubscribe?.();
		await this.current?.dispose();
		await this.history.flush();
		await sessionsClosed;
		this.listeners.clear();
	}
}
