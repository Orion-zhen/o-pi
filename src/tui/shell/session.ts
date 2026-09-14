import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatStartupBanner } from "../views/home/banner.ts";
import { clearChrome, formatStatus, formatTitle, TUI_STATUS_KEY, workingIndicatorOptions } from "./chrome.ts";
import { formatFooter } from "./footer.ts";
import { installFullscreenImageFix } from "../terminal/fullscreen-images.ts";
import { formatHomeFooter, selectHomeTip } from "../views/home/home.ts";
import { configureTuiIconMode } from "../components/icons.ts";
import { configureMessageTimestampRenderer, resetUserMessageTimestamps } from "../chat/message-timestamp.ts";
import { SessionEditor } from "../editor/editor.ts";
import {
	collectSessionState,
	collectSkills,
	collectTools,
	collectUserMessages,
	countAvailableProviders,
	userMessageText,
} from "./snapshot.ts";
import type { TuiConfig, TuiRunStatus, TuiSkillsSnapshot, TuiSnapshot } from "./types.ts";
import { buildInitialHistory, normalizeHistoryCwd, type UserHistoryRecord, type UserHistoryStore } from "../editor/history.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** 一次活动会话拥有全部界面资源，组件只读取快照和当前 Home 可见性。 */
export class TuiSession {
	private state: ReturnType<typeof collectSessionState>;
	private readonly skills: TuiSkillsSnapshot | undefined;
	private homeVisible: boolean;
	private footerData: ReadonlyFooterDataProvider | undefined;
	private editor: SessionEditor | undefined;
	private editorFactory: EditorFactory | undefined;
	private previousEditorFactory: EditorFactory | undefined;
	private restoreImageOutput: (() => void) | undefined;
	private disposed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly config: TuiConfig,
		private readonly history: UserHistoryStore,
	) {
		this.state = collectSessionState(ctx, "ready");
		this.homeVisible = config.home.enabled && !ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
		this.skills = this.homeVisible ? collectSkills(pi) : undefined;
	}

	get status(): TuiRunStatus {
		return this.state.status;
	}

	async start(replaySessionMessages: boolean): Promise<void> {
		const { ctx, config } = this;
		configureTuiIconMode(config.icons);
		configureMessageTimestampRenderer({
			dim: (text) => ctx.ui.theme.fg("dim", text),
			userBackground: (text) => ctx.ui.theme.bg("userMessageBg", text),
			customBackground: (text) => ctx.ui.theme.bg("customMessageBg", text),
		});
		const messages = collectUserMessages(ctx);
		resetUserMessageTimestamps(messages);
		const sessionMessages = messages
			.map((message) => ({ timestamp: message.timestamp, text: userMessageText(message) }))
			.filter((message) => message.text.length > 0);
		const cwd = normalizeHistoryCwd(ctx.cwd);
		const session = ctx.sessionManager.getSessionId();
		let records: UserHistoryRecord[] = [];
		let warned = false;
		try {
			records = await this.history.load(cwd);
		} catch (error) {
			warned = true;
			if (!this.disposed) this.warnHistory("loaded", error);
		}
		if (this.disposed) return;
		const initialHistory = buildInitialHistory(records, sessionMessages, session);
		const replayHistory = replaySessionMessages ? sessionMessages.map((message) => message.text) : [];
		this.previousEditorFactory = ctx.ui.getEditorComponent();
		this.editorFactory = (tui, theme, keybindings) => {
			this.restoreImageOutput?.();
			this.restoreImageOutput = installFullscreenImageFix(tui);
			// 编辑器重建时释放旧实例的动画。
			this.editor?.dispose();
			this.editor = new SessionEditor(tui, theme, keybindings, {
				initialHistory,
				replayHistory,
				getSnapshot: this.getSnapshot,
				getTheme: () => ctx.ui.theme,
				record: (text) => {
					void this.history.append({ cwd, session, text }).catch((error: unknown) => {
						if (warned) return;
						warned = true;
						this.warnHistory("saved", error);
					});
				},
				...(config.home.enabled ? { home: {
					config: config.home,
					isVisible: () => this.homeVisible,
					onSubmit: () => this.leaveHome(),
					tip: selectHomeTip(session),
				} } : {}),
			});
			return this.editor;
		};
		ctx.ui.setEditorComponent(this.editorFactory);
		ctx.ui.setWorkingIndicator(workingIndicatorOptions(config, ctx.ui.theme));
		this.installChrome();
	}

	refresh(status: TuiRunStatus = this.status): void {
		this.state = collectSessionState(this.ctx, status);
		this.redraw();
	}

	/** setStatus 是 Pi 公开的重绘入口，组件无需为状态变化反复重建。 */
	redraw(): void {
		this.updateTitle();
		this.ctx.ui.setStatus(TUI_STATUS_KEY, formatStatus(this.status, this.ctx.ui.theme));
	}

	leaveHome(): void {
		if (!this.homeVisible) return;
		this.homeVisible = false;
		this.editor?.hideHome();
		this.installChrome();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.homeVisible = false;
		this.editor?.dispose();
		this.restoreImageOutput?.();
		this.restoreImageOutput = undefined;
		if (this.editorFactory !== undefined && this.ctx.ui.getEditorComponent() === this.editorFactory) {
			this.ctx.ui.setEditorComponent(this.previousEditorFactory);
		}
		configureMessageTimestampRenderer(undefined);
		resetUserMessageTimestamps([]);
		configureTuiIconMode("unicode");
		clearChrome(this.ctx);
	}

	private readonly getSnapshot = (): TuiSnapshot => {
		const sessionName = this.pi.getSessionName();
		const git = this.footerData?.getGitBranch();
		return {
			...this.state,
			thinkingLevel: this.pi.getThinkingLevel(),
			availableProviderCount: countAvailableProviders(this.ctx),
			hasPendingMessages: this.ctx.hasPendingMessages(),
			tools: collectTools(this.pi),
			...(sessionName === undefined ? {} : { sessionName }),
			...(git === undefined || git === null ? {} : { git }),
			...(this.skills === undefined ? {} : { skills: this.skills }),
		};
	};

	/** 只在启动和离开 Home 时安装组件，regular/fullscreen 的选择集中在这里。 */
	private installChrome(): void {
		const { ctx, config } = this;
		ctx.ui.setFooter(config.chrome.footer ? (tui, theme, provider) => {
			this.footerData = provider;
			this.updateTitle();
			const unsubscribe = provider.onBranchChange(() => {
				this.updateTitle();
				tui.requestRender();
			});
			return {
				render: (width) => this.homeVisible && tui.mode === "fullscreen"
					? formatHomeFooter(config.home, width, theme)
					: formatFooter(this.getSnapshot(), config.footer, width, theme),
				invalidate() {},
				dispose: unsubscribe,
			};
		} : undefined);
		ctx.ui.setHeader(this.homeVisible || config.chrome.header ? (tui, theme) => ({
			render: (width) => this.homeVisible
				? tui.mode === "regular" ? formatStartupBanner(this.getSnapshot(), config.home, width, theme) : []
				: new Text(theme.fg("dim", formatTitle(this.getSnapshot())), 0, 0).render(width),
			invalidate() {},
		}) : undefined);
		this.redraw();
	}

	private updateTitle(): void {
		if (this.config.chrome.title) this.ctx.ui.setTitle(formatTitle(this.getSnapshot()));
	}

	private warnHistory(operation: "loaded" | "saved", error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.ctx.ui.notify(`User history could not be ${operation}: ${message}`, "warning");
	}
}
