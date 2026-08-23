import path from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	loadSkillsFromDir,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { notifyWaiting, type WaitingNotifier } from "../notification/native.js";
import { collectSkillCandidates } from "../skill-context/loader.js";
import { createStartupBannerComponent } from "./banner.js";
import { createHeaderComponent, formatTitle, workingIndicatorOptions } from "./chrome.js";
import { loadTuiConfig } from "./config.js";
import { createFooterComponent } from "./footer.js";
import { createHomeFooterComponent, createHomeHeaderComponent, selectHomeTip } from "./home.js";
import { configureTuiIconMode, statusIcon } from "./icons.js";
import { createAssistantPerformanceTracker } from "./message-performance.js";
import {
	configureMessageTimestampRenderer,
	recordUserMessageTimestamp,
	resetUserMessageTimestamps,
} from "./message-timestamp.js";
import type { TuiConfig, TuiFooterSkillsSnapshot, TuiFooterSnapshot, TuiFooterToolsSnapshot } from "./types.js";
import { UserHistoryEditor } from "./user-history-editor.js";
import {
	buildInitialHistory,
	normalizeHistoryCwd,
	type SessionHistoryMessage,
	type UserHistoryRecord,
	UserHistoryStore,
} from "./user-history.js";

const STATUS_KEY = "o-pi:tui";
const MATH_IDLE_DELAY_MS = 750;

export interface MathMarkdownModule {
	installMathMarkdownRenderer(config: TuiConfig["math"]): void;
	supportsDisplayMathImages(): boolean;
	warmDisplayMathRenderer(): Promise<void>;
}

export type MathMarkdownLoader = () => Promise<MathMarkdownModule>;

export interface TuiRuntimeModule {
	createTuiRuntime(pi: ExtensionAPI, loadMathMarkdown?: MathMarkdownLoader, notifyUser?: WaitingNotifier): TuiRuntime;
}

export interface TuiSessionStartOptions {
	replaySessionMessages?: boolean;
}

export interface TuiRuntime {
	startSession(ctx: ExtensionContext, options?: TuiSessionStartOptions): Promise<void>;
	dispose(ctx: ExtensionContext): Promise<void> | void;
}

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** 原生 Pi TUI runtime；由 extension bootstrap 仅在 native 模式激活。 */
export function createTuiRuntime(
	pi: ExtensionAPI,
	loadMathMarkdown: MathMarkdownLoader = loadDefaultMathMarkdown,
	notifyUser: WaitingNotifier = notifyWaiting,
): TuiRuntime {
	let config: TuiConfig | undefined;
	let snapshot: TuiFooterSnapshot = {};
	let setTitle: ((title: string) => void) | undefined;
	let refreshHeader: (() => void) | undefined;
	let footerDataProvider: ReadonlyFooterDataProvider | undefined;
	let homeVisible = false;
	let mathMarkdownModule: MathMarkdownModule | undefined;
	let mathMarkdownLoad: Promise<MathMarkdownModule> | undefined;
	let mathImagesWarm = false;
	let mathTimer: ReturnType<typeof setTimeout> | undefined;
	let sessionGeneration = 0;
	let skillsSnapshot: TuiFooterSkillsSnapshot | undefined;
	let historyEditorFactory: EditorFactory | undefined;
	let historyEditor: UserHistoryEditor | undefined;
	let previousEditorFactory: EditorFactory | undefined;
	const assistantPerformance = createAssistantPerformanceTracker();
	const userHistory = new UserHistoryStore();

	registerHandlers();

	return { startSession, dispose };

	async function startSession(ctx: ExtensionContext, options: TuiSessionStartOptions = {}): Promise<void> {
		await resetSession(ctx);
		const nextConfig = await loadTuiConfig();
		config = nextConfig;
		setTitle = (title) => ctx.ui.setTitle(title);
		refreshHeader = () => ctx.ui.setHeader(getHeader());
		const mathEnabled = nextConfig.enabled && nextConfig.math.enabled;
		mathMarkdownModule?.installMathMarkdownRenderer({ ...nextConfig.math, enabled: mathEnabled });
		if (!nextConfig.enabled) {
			cleanup(ctx);
			return;
		}

		configureTuiIconMode(nextConfig.icons);
		configureMessageTimestampRenderer({
			dim: (text) => ctx.ui.theme.fg("dim", text),
			userBackground: (text) => ctx.ui.theme.bg("userMessageBg", text),
			customBackground: (text) => ctx.ui.theme.bg("customMessageBg", text),
		});
		syncUserMessageTimestamps(ctx);
		homeVisible = nextConfig.home.enabled && !hasConversation(ctx);
		skillsSnapshot = nextConfig.home.enabled ? collectSkills(pi) : undefined;
		snapshot = makeSnapshot(ctx, pi, "ready");
		await installUserHistory(ctx, options.replaySessionMessages === true, nextConfig);
		applyChrome(ctx, nextConfig, currentSnapshot, homeVisible, bindFooterData);
		scheduleMathInitialization(ctx, sessionGeneration);
	}

	async function dispose(ctx: ExtensionContext): Promise<void> {
		await resetSession(ctx);
	}

	async function resetSession(ctx: ExtensionContext): Promise<void> {
		sessionGeneration += 1;
		cancelMathInitialization();
		await userHistory.flush();
		restoreEditor(ctx);
		footerDataProvider = undefined;
		if (config !== undefined || setTitle !== undefined || homeVisible) cleanup(ctx);
		config = undefined;
		setTitle = undefined;
		refreshHeader = undefined;
		homeVisible = false;
		snapshot = {};
		skillsSnapshot = undefined;
		assistantPerformance.reset();
	}

	async function installUserHistory(ctx: ExtensionContext, replaySessionMessages: boolean, currentConfig: TuiConfig): Promise<void> {
		const cwd = normalizeHistoryCwd(ctx.cwd);
		const session = ctx.sessionManager.getSessionId();
		const sessionMessages = collectSessionHistoryMessages(ctx);
		let records: UserHistoryRecord[] = [];
		let warned = false;
		try {
			records = await userHistory.load(cwd);
		} catch (error) {
			warned = true;
			ctx.ui.notify(`User history could not be loaded: ${stringifyError(error)}`, "warning");
		}
		const initialHistory = buildInitialHistory(records, sessionMessages, session);
		const replayQueue = replaySessionMessages ? sessionMessages.map((message) => message.text) : [];
		previousEditorFactory = ctx.ui.getEditorComponent();
		historyEditorFactory = (tui, theme, keybindings) => {
			const editor = new UserHistoryEditor(
				tui,
				theme,
				keybindings,
				initialHistory,
				replayQueue,
				(text) => {
					void userHistory.append({ cwd, session, text }).catch((error: unknown) => {
						if (warned) return;
						warned = true;
						ctx.ui.notify(`User history could not be saved: ${stringifyError(error)}`, "warning");
					});
				},
				{
					getState: () => {
						const sessionName = pi.getSessionName();
						const availableProviderCount = countAvailableProviders(ctx);
						return {
							...(sessionName !== undefined ? { sessionName } : {}),
							...(snapshot.modelId !== undefined ? { modelId: snapshot.modelId } : {}),
							...(snapshot.modelProvider !== undefined ? { modelProvider: snapshot.modelProvider } : {}),
							...(snapshot.modelReasoning !== undefined ? { modelReasoning: snapshot.modelReasoning } : {}),
							...(availableProviderCount > 0 ? { availableProviderCount } : {}),
							...(snapshot.status !== undefined ? { status: snapshot.status } : {}),
							thinkingLevel: pi.getThinkingLevel(),
							hasPendingMessages: ctx.hasPendingMessages(),
						};
					},
					styleLabel: (text) => ctx.ui.theme.fg("dim", text),
					styleMode: (text) => ctx.ui.theme.fg("warning", text),
					styleStatus: (text) => ctx.ui.theme.fg("success", text),
				},
				{
					config: currentConfig.home,
					getSnapshot: currentSnapshot,
					getTheme: () => ctx.ui.theme,
					isVisible: () => homeVisible,
					onSubmit: () => leaveHome(ctx),
					tip: selectHomeTip(session),
				},
			);
			historyEditor = editor;
			return editor;
		};
		ctx.ui.setEditorComponent(historyEditorFactory);
	}

	function leaveHome(ctx: ExtensionContext): void {
		if (!homeVisible || config === undefined) return;
		homeVisible = false;
		historyEditor?.hideHome();
		ctx.ui.setFooter(config.chrome.footer
			? createFooterComponent(config.footer, currentSnapshot, config.icons, bindFooterData)
			: undefined);
		ctx.ui.setHeader(config.chrome.header
			? createHeaderComponent(currentSnapshot)
			: undefined);
	}

	function restoreEditor(ctx: ExtensionContext): void {
		historyEditor?.dispose();
		historyEditor = undefined;
		if (historyEditorFactory !== undefined && ctx.ui.getEditorComponent() === historyEditorFactory) {
			ctx.ui.setEditorComponent(previousEditorFactory);
		}
		historyEditorFactory = undefined;
		previousEditorFactory = undefined;
	}

	function registerHandlers(): void {
		pi.on("agent_start", async (_event, ctx) => {
			cancelMathInitialization();
			if (!config?.enabled) return;
			snapshot = makeSnapshot(ctx, pi, "running");
			leaveHome(ctx);
			ctx.ui.setStatus(STATUS_KEY, formatStatus("running", ctx.ui.theme));
			refreshTitle();
		});

		pi.on("turn_end", async (_event, ctx) => {
			if (!config?.enabled) return;
			snapshot = makeSnapshot(ctx, pi, "running");
			ctx.ui.setStatus(STATUS_KEY, formatStatus("running", ctx.ui.theme));
			refreshTitle();
			refreshHeader?.();
		});

		pi.on("agent_settled", async (_event, ctx) => {
			if (config?.enabled) {
				snapshot = makeSnapshot(ctx, pi, "ready");
				ctx.ui.setStatus(STATUS_KEY, formatStatus("ready", ctx.ui.theme));
				refreshTitle();
				refreshHeader?.();
				scheduleMathInitialization(ctx, sessionGeneration);
			}
			if (ctx.mode !== "tui") return;
			try {
				await notifyUser();
			} catch {
				// 通知失败不得影响 Agent 的结束状态。
			}
		});

		pi.on("before_provider_headers", () => {
			if (config?.enabled) assistantPerformance.startRequest();
		});

		pi.on("message_start", (event) => {
			if (!config?.enabled) return;
			if (event.message.role === "user") recordUserMessageTimestamp(event.message);
			else if (event.message.role === "assistant") assistantPerformance.startMessage(event.message);
		});

		pi.on("message_update", (event) => {
			if (config?.enabled && event.message.role === "assistant") {
				assistantPerformance.updateMessage(event.message, event.assistantMessageEvent);
			}
		});

		pi.on("message_end", (event) => {
			if (config?.enabled && event.message.role === "assistant") assistantPerformance.endMessage(event.message);
		});

		pi.on("session_compact", (_event, ctx) => {
			if (config?.enabled) syncUserMessageTimestamps(ctx);
		});

		pi.on("session_tree", (_event, ctx) => {
			if (config?.enabled) syncUserMessageTimestamps(ctx);
		});

		pi.on("model_select", async (_event, ctx) => {
			if (!config?.enabled) return;
			refreshSnapshot(ctx);
		});

		pi.on("thinking_level_select", async (_event, ctx) => {
			if (!config?.enabled) return;
			refreshSnapshot(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			await dispose(ctx);
		});
	}

	function cancelMathInitialization(): void {
		if (mathTimer === undefined) return;
		clearTimeout(mathTimer);
		mathTimer = undefined;
	}

	function scheduleMathInitialization(ctx: ExtensionContext, generation: number): void {
		cancelMathInitialization();
		const current = config;
		if (
			current === undefined
			|| !current.enabled
			|| !current.math.enabled
			|| ctx.mode !== "tui"
			|| mathInitializationComplete(mathMarkdownModule, mathImagesWarm)
		) return;
		mathTimer = setTimeout(() => {
			mathTimer = undefined;
			if (generation !== sessionGeneration || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			void initializeMathMarkdown(current, ctx, generation);
		}, MATH_IDLE_DELAY_MS);
		mathTimer.unref();
	}

	async function initializeMathMarkdown(current: TuiConfig, ctx: ExtensionContext, generation: number): Promise<void> {
		try {
			const module = await getMathMarkdownModule();
			if (generation !== sessionGeneration || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			module.installMathMarkdownRenderer({ ...current.math, enabled: true });
			if (module.supportsDisplayMathImages()) {
				await module.warmDisplayMathRenderer();
				mathImagesWarm = true;
			}
			if (generation === sessionGeneration) ctx.ui.setStatus(STATUS_KEY, formatStatus("ready", ctx.ui.theme));
		} catch (error) {
			if (generation === sessionGeneration) ctx.ui.notify(`Math renderer initialization failed: ${stringifyError(error)}`, "warning");
		}
	}

	function getMathMarkdownModule(): Promise<MathMarkdownModule> {
		if (mathMarkdownModule !== undefined) return Promise.resolve(mathMarkdownModule);
		if (mathMarkdownLoad !== undefined) return mathMarkdownLoad;
		const pending = loadMathMarkdown().then((module) => {
			mathMarkdownModule = module;
			mathMarkdownLoad = undefined;
			return module;
		}, (error: unknown) => {
			mathMarkdownLoad = undefined;
			throw error;
		});
		mathMarkdownLoad = pending;
		return pending;
	}

	function refreshTitle(): void {
		if (config?.chrome.title === true && setTitle !== undefined) setTitle(formatTitle(currentSnapshot()));
	}

	function bindFooterData(provider: ReadonlyFooterDataProvider): void {
		footerDataProvider = provider;
		refreshTitle();
		refreshHeader?.();
	}

	function currentSnapshot(): TuiFooterSnapshot {
		return snapshotWithCapabilities(snapshot, pi, skillsSnapshot, footerDataProvider);
	}

	/** 模型和 thinking 选择不会开启 turn，需要主动刷新快照并触发 Pi 公开 UI 重绘入口。 */
	function refreshSnapshot(ctx: ExtensionContext): void {
		const status = snapshot.status ?? "ready";
		snapshot = makeSnapshot(ctx, pi, status);
		refreshTitle();
		ctx.ui.setStatus(STATUS_KEY, formatStatus(status, ctx.ui.theme));
		ctx.ui.setFooter(config?.chrome.footer
			? homeVisible
				? createStartupFooterComponent(config, currentSnapshot, bindFooterData)
				: createFooterComponent(config.footer, currentSnapshot, config.icons, bindFooterData)
			: undefined);
		ctx.ui.setHeader(getHeader());
	}

	function getHeader() {
		if (config === undefined) return undefined;
		if (homeVisible) return createStartupHeaderComponent(config, currentSnapshot);
		return config.chrome.header ? createHeaderComponent(currentSnapshot) : undefined;
	}

	function cleanup(ctx: ExtensionContext): void {
		configureMessageTimestampRenderer(undefined);
		resetUserMessageTimestamps([]);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setHeader(undefined);
		ctx.ui.setWorkingIndicator();
		configureTuiIconMode("unicode");
		if (ctx.cwd) ctx.ui.setTitle(formatTitle({ cwd: ctx.cwd, status: "ready" }));
	}
}

function collectSessionHistoryMessages(ctx: ExtensionContext): SessionHistoryMessage[] {
	return ctx.sessionManager.buildContextEntries()
		.flatMap(sessionEntryToContextMessages)
		.filter((message): message is UserMessage => message.role === "user")
		.map((message) => ({
			timestamp: message.timestamp,
			text: typeof message.content === "string"
				? message.content
				: message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join(""),
		}))
		.filter((message) => message.text.length > 0);
}

function syncUserMessageTimestamps(ctx: ExtensionContext): void {
	const messages = ctx.sessionManager.buildContextEntries()
		.flatMap(sessionEntryToContextMessages)
		.filter((message): message is UserMessage => message.role === "user");
	resetUserMessageTimestamps(messages);
}

function mathInitializationComplete(
	module: MathMarkdownModule | undefined,
	mathImagesWarm: boolean,
): boolean {
	if (module === undefined) return false;
	return mathImagesWarm || !module.supportsDisplayMathImages();
}

async function loadDefaultMathMarkdown(): Promise<MathMarkdownModule> {
	return import("./math-markdown.js");
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function applyChrome(
	ctx: ExtensionContext,
	config: TuiConfig,
	getSnapshot: () => TuiFooterSnapshot,
	homeVisible: boolean,
	bindFooterData: (provider: ReadonlyFooterDataProvider) => void,
): void {
	if (config.chrome.title) ctx.ui.setTitle(formatTitle(getSnapshot()));
	ctx.ui.setWorkingIndicator(workingIndicatorOptions(config, ctx.ui.theme));
	ctx.ui.setStatus(STATUS_KEY, formatStatus("ready", ctx.ui.theme));
	ctx.ui.setFooter(config.chrome.footer
		? homeVisible
			? createStartupFooterComponent(config, getSnapshot, bindFooterData)
			: createFooterComponent(config.footer, getSnapshot, config.icons, bindFooterData)
		: undefined);
	ctx.ui.setHeader(homeVisible
		? createStartupHeaderComponent(config, getSnapshot)
		: config.chrome.header ? createHeaderComponent(getSnapshot) : undefined);
}

type HomeHeaderFactory = ReturnType<typeof createHomeHeaderComponent>;
type HomeFooterFactory = ReturnType<typeof createHomeFooterComponent>;

/** regular 恢复旧版 header banner；fullscreen 保留当前沉浸式 Home。 */
function createStartupHeaderComponent(config: TuiConfig, getSnapshot: () => TuiFooterSnapshot): HomeHeaderFactory {
	const regular = createStartupBannerComponent(config.home, getSnapshot);
	const fullscreen = createHomeHeaderComponent();
	const factory: HomeHeaderFactory = (tui, theme) => tui.mode === "regular"
		? regular(tui, theme)
		: fullscreen(tui, theme);
	return factory;
}

/** regular 使用普通状态 footer，fullscreen 使用 Home 操作 footer。 */
function createStartupFooterComponent(
	config: TuiConfig,
	getSnapshot: () => TuiFooterSnapshot,
	bindFooterData: (provider: ReadonlyFooterDataProvider) => void,
): HomeFooterFactory {
	const regular = createFooterComponent(config.footer, getSnapshot, config.icons, bindFooterData);
	const fullscreen = createHomeFooterComponent(config.home, bindFooterData);
	const factory: HomeFooterFactory = (tui, theme, footerData) => tui.mode === "regular"
		? regular(tui, theme, footerData)
		: fullscreen(tui, theme, footerData);
	return factory;
}

function formatStatus(status: string, theme: ExtensionContext["ui"]["theme"]): string {
	if (status === "running") return theme.fg("warning", `${statusIcon("running")} running`);
	return theme.fg("success", `${statusIcon("success")} ready`);
}

function snapshotWithCapabilities(
	snapshot: TuiFooterSnapshot,
	pi: ExtensionAPI,
	skills: TuiFooterSkillsSnapshot | undefined,
	footerData: ReadonlyFooterDataProvider | undefined,
): TuiFooterSnapshot {
	const next: TuiFooterSnapshot = {
		...snapshot,
		tools: collectTools(pi),
		...(skills !== undefined ? { skills } : {}),
	};
	delete next.git;
	const branch = footerData?.getGitBranch();
	if (branch !== undefined && branch !== null) next.git = branch;
	return next;
}

function makeSnapshot(ctx: ExtensionContext, pi: ExtensionAPI, status: string): TuiFooterSnapshot {
	const context = ctx.getContextUsage();
	const usage = collectUsage(ctx);
	const model = ctx.model;
	const availableProviderCount = countAvailableProviders(ctx);
	return {
		cwd: ctx.cwd,
		...(model?.id !== undefined ? { modelId: model.id } : {}),
		...(model?.provider !== undefined ? { modelProvider: model.provider } : {}),
		...(model?.reasoning !== undefined ? { modelReasoning: model.reasoning } : {}),
		...(availableProviderCount > 0 ? { availableProviderCount } : {}),
		thinkingLevel: pi.getThinkingLevel(),
		...(model !== undefined ? { usingSubscription: ctx.modelRegistry.isUsingOAuth(model) } : {}),
		...(context !== undefined ? { context } : {}),
		...usage,
		status,
	};
}

function countAvailableProviders(ctx: ExtensionContext): number {
	return new Set(ctx.modelRegistry.getAvailable().map((available) => available.provider)).size;
}

/** 按工具注册顺序生成启用状态，避免 /tools 切换后 footer 列表抖动。 */
function collectTools(pi: ExtensionAPI): TuiFooterToolsSnapshot {
	const allNames = pi.getAllTools().map((tool) => tool.name);
	const activeSet = new Set(pi.getActiveTools());
	const activeNames = allNames.filter((name) => activeSet.has(name));
	return { activeNames, totalCount: allNames.length, allNames };
}

/** 复用 skill 索引规则统计去重总数和模型可调用数。 */
function collectSkills(pi: ExtensionAPI): TuiFooterSkillsSnapshot | undefined {
	const commands = pi.getCommands();
	const candidates = collectSkillCandidates(undefined, commands);
	const totalCount = candidates.length;
	if (totalCount === 0) return undefined;
	const skillsByDirectory = new Map<string, Skill[]>();
	let modelInvocableCount = 0;
	for (const candidate of candidates) {
		const directory = path.dirname(candidate.path);
		let parsedSkills = skillsByDirectory.get(directory);
		if (parsedSkills === undefined) {
			parsedSkills = loadSkillsFromDir({ dir: directory, source: candidate.scope }).skills;
			skillsByDirectory.set(directory, parsedSkills);
		}
		const candidatePath = path.resolve(candidate.path);
		const parsed = parsedSkills.find((skill) => path.resolve(skill.filePath) === candidatePath);
		if (parsed !== undefined && !parsed.disableModelInvocation) modelInvocableCount += 1;
	}
	return { totalCount, modelInvocableCount };
}

function hasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

function collectUsage(ctx: ExtensionContext): Pick<
	TuiFooterSnapshot,
	"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "latestCacheHitRate" | "totalCacheHitRate" | "costUsd"
> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		inputTokens += usage.input;
		outputTokens += usage.output;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
		costUsd += usage.cost.total;
		const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
	}
	const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	const totalCacheHitRate = totalPromptTokens > 0 ? (cacheReadTokens / totalPromptTokens) * 100 : undefined;
	return {
		...(inputTokens > 0 ? { inputTokens } : {}),
		...(outputTokens > 0 ? { outputTokens } : {}),
		...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
		...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
		...(latestCacheHitRate !== undefined ? { latestCacheHitRate } : {}),
		...(totalCacheHitRate !== undefined ? { totalCacheHitRate } : {}),
		...(costUsd > 0 ? { costUsd } : {}),
	};
}
