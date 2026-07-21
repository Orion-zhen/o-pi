import path from "node:path";
import { loadSkillsFromDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { createStartupBannerComponent } from "../../src/tui/banner.js";
import { collectSkillCandidates } from "../../src/skill-context/loader.js";
import { createHeaderComponent, formatTitle, workingIndicatorOptions } from "../../src/tui/chrome.js";
import { loadTuiConfig } from "../../src/tui/config.js";
import { createFooterComponent, GitSegmentCache } from "../../src/tui/footer.js";
import type { TuiConfig, TuiFooterSkillsSnapshot, TuiFooterSnapshot, TuiFooterToolsSnapshot } from "../../src/tui/types.js";

const STATUS_KEY = "o-pi:tui";
const REPO_MAP_STATUS_KEY = "repo-map";
const MATH_IDLE_DELAY_MS = 750;

export interface MathMarkdownModule {
	installMathMarkdownRenderer(config: TuiConfig["math"]): void;
	supportsDisplayMathImages(): boolean;
	warmDisplayMathRenderer(): Promise<void>;
}

export type MathMarkdownLoader = () => Promise<MathMarkdownModule>;

/** 注册 o-pi TUI V1：只使用 Pi 公开 UI API，不替换主 TUI 或 input editor。 */
export function createTuiExtension(loadMathMarkdown: MathMarkdownLoader = loadDefaultMathMarkdown): (pi: ExtensionAPI) => void {
	return (pi) => registerTuiExtension(pi, loadMathMarkdown);
}

function registerTuiExtension(pi: ExtensionAPI, loadMathMarkdown: MathMarkdownLoader): void {
	let config: TuiConfig | undefined;
	let snapshot: TuiFooterSnapshot = {};
	let setTitle: ((title: string) => void) | undefined;
	let gitCache: GitSegmentCache | undefined;
	let startupBannerVisible = false;
	let mathMarkdownModule: MathMarkdownModule | undefined;
	let mathMarkdownLoad: Promise<MathMarkdownModule> | undefined;
	let displayMathWarm = false;
	let mathTimer: ReturnType<typeof setTimeout> | undefined;
	let sessionGeneration = 0;
	let skillsSnapshot: TuiFooterSkillsSnapshot | undefined;

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		cancelMathInitialization();
		gitCache?.dispose();
		gitCache = createGitCache(() => snapshot, (next) => {
			snapshot = next;
			refreshTitle();
		});
		config = await loadTuiConfig();
		skillsSnapshot = config.banner.enabled ? collectSkills(pi) : undefined;
		const mathEnabled = config.enabled && config.math.enabled;
		mathMarkdownModule?.installMathMarkdownRenderer({ ...config.math, enabled: mathEnabled });
		snapshot = makeSnapshot(ctx, pi, "ready", gitCache.get(ctx.cwd));
		setTitle = (title) => ctx.ui.setTitle(title);
		if (!config.enabled) {
			startupBannerVisible = false;
			cleanup(ctx);
			return;
		}
		applyChrome(ctx, config, () => snapshotWithCapabilities(snapshot, pi, skillsSnapshot));
		if (config.banner.enabled) {
			startupBannerVisible = true;
			ctx.ui.setHeader(createStartupBannerComponent(config.banner, () => snapshotWithCapabilities(snapshot, pi, skillsSnapshot)));
		}
		scheduleMathInitialization(ctx, sessionGeneration);
	});

	pi.on("turn_start", async (_event, ctx) => {
		cancelMathInitialization();
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "running", gitCache?.get(ctx.cwd));
		if (startupBannerVisible && config.banner.clear_on_first_turn) {
			startupBannerVisible = false;
			ctx.ui.setHeader(config.chrome.header ? createHeaderComponent(() => snapshotWithCapabilities(snapshot, pi, skillsSnapshot)) : undefined);
		}
		gitCache?.refresh(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, formatStatus("running", ctx.ui.theme));
		refreshTitle();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "ready", gitCache?.get(ctx.cwd));
		gitCache?.refresh(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, formatStatus("ready", ctx.ui.theme));
		refreshTitle();
		scheduleMathInitialization(ctx, sessionGeneration);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "working", gitCache?.get(ctx.cwd));
		refreshTitle();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "ready", gitCache?.get(ctx.cwd));
		gitCache?.refresh(ctx.cwd);
		refreshTitle();
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
		sessionGeneration += 1;
		cancelMathInitialization();
		cleanup(ctx);
		gitCache?.dispose();
		gitCache = undefined;
		config = undefined;
		setTitle = undefined;
		startupBannerVisible = false;
		snapshot = {};
		skillsSnapshot = undefined;
	});

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
			|| mathInitializationComplete(current, mathMarkdownModule, displayMathWarm)
		) return;
		mathTimer = setTimeout(() => {
			mathTimer = undefined;
			if (generation !== sessionGeneration) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				scheduleMathInitialization(ctx, generation);
				return;
			}
			void initializeMathMarkdown(current, ctx, generation);
		}, MATH_IDLE_DELAY_MS);
		mathTimer.unref();
	}

	async function initializeMathMarkdown(current: TuiConfig, ctx: ExtensionContext, generation: number): Promise<void> {
		try {
			const module = await getMathMarkdownModule();
			if (generation !== sessionGeneration) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				scheduleMathInitialization(ctx, generation);
				return;
			}
			module.installMathMarkdownRenderer({ ...current.math, enabled: true });
			if (current.math.display && module.supportsDisplayMathImages()) {
				await module.warmDisplayMathRenderer();
				displayMathWarm = true;
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
		if (config?.chrome.title === true && setTitle !== undefined) setTitle(formatTitle(snapshot));
	}

	/** 模型和 thinking 选择不会开启 turn，需要主动刷新快照并触发 Pi 公开 UI 重绘入口。 */
	function refreshSnapshot(ctx: ExtensionContext): void {
		const status = snapshot.status ?? "ready";
		snapshot = makeSnapshot(ctx, pi, status, gitCache?.get(ctx.cwd));
		refreshTitle();
		ctx.ui.setStatus(STATUS_KEY, formatStatus(status, ctx.ui.theme));
		ctx.ui.setFooter(config?.chrome.footer ? createFooterComponent(config.footer, () => snapshotWithCapabilities(snapshot, pi, skillsSnapshot), STATUS_KEY, REPO_MAP_STATUS_KEY) : undefined);
		ctx.ui.setHeader(getHeader());
	}

	function getHeader() {
		if (config === undefined) return undefined;
		if (startupBannerVisible && config.banner.enabled) return createStartupBannerComponent(config.banner, () => snapshotWithCapabilities(snapshot, pi, skillsSnapshot));
		return config.chrome.header ? createHeaderComponent(() => snapshotWithCapabilities(snapshot, pi, skillsSnapshot)) : undefined;
	}

	function cleanup(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setHeader(undefined);
		ctx.ui.setWorkingIndicator();
		if (ctx.cwd) ctx.ui.setTitle(formatTitle({ cwd: ctx.cwd, status: "ready" }));
	}
}

function mathInitializationComplete(
	config: TuiConfig,
	module: MathMarkdownModule | undefined,
	displayMathWarm: boolean,
): boolean {
	if (module === undefined) return false;
	return !config.math.display || displayMathWarm || !module.supportsDisplayMathImages();
}

async function loadDefaultMathMarkdown(): Promise<MathMarkdownModule> {
	return import("../../src/tui/math-markdown.js");
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const tuiExtension = createTuiExtension();

export default tuiExtension;

function applyChrome(ctx: ExtensionContext, config: TuiConfig, getSnapshot: () => TuiFooterSnapshot): void {
	if (config.chrome.title) ctx.ui.setTitle(formatTitle(getSnapshot()));
	ctx.ui.setWorkingIndicator(workingIndicatorOptions(config, ctx.ui.theme));
	ctx.ui.setStatus(STATUS_KEY, formatStatus("ready", ctx.ui.theme));
	ctx.ui.setFooter(config.chrome.footer ? createFooterComponent(config.footer, getSnapshot, STATUS_KEY, REPO_MAP_STATUS_KEY) : undefined);
	ctx.ui.setHeader(config.chrome.header ? createHeaderComponent(getSnapshot) : undefined);
}

function formatStatus(status: string, theme: ExtensionContext["ui"]["theme"]): string {
	if (status === "running" || status === "working") return theme.fg("warning", "● running");
	return theme.fg("success", "✓ ready");
}

function snapshotWithCapabilities(
	snapshot: TuiFooterSnapshot,
	pi: ExtensionAPI,
	skills: TuiFooterSkillsSnapshot | undefined,
): TuiFooterSnapshot {
	return {
		...snapshot,
		tools: collectTools(pi),
		...(skills !== undefined ? { skills } : {}),
	};
}

function makeSnapshot(ctx: ExtensionContext, pi: ExtensionAPI, status: string, git: string | undefined): TuiFooterSnapshot {
	const context = ctx.getContextUsage();
	const usage = collectUsage(ctx);
	const model = ctx.model;
	return {
		cwd: ctx.cwd,
		...(git !== undefined ? { git } : {}),
		...(model?.id !== undefined ? { modelId: model.id } : {}),
		...(model?.provider !== undefined ? { modelProvider: model.provider } : {}),
		...(model?.reasoning !== undefined ? { modelReasoning: model.reasoning } : {}),
		thinkingLevel: pi.getThinkingLevel(),
		...(model !== undefined ? { usingSubscription: ctx.modelRegistry.isUsingOAuth(model) } : {}),
		...(context !== undefined ? { context } : {}),
		...usage,
		status,
	};
}

/** 按工具注册顺序生成启用状态，避免 /tools 切换后 footer 列表抖动。 */
function collectTools(pi: ExtensionAPI): TuiFooterToolsSnapshot {
	const allNames = pi.getAllTools().map((tool) => tool.name);
	const activeSet = new Set(pi.getActiveTools());
	const activeNames = allNames.filter((name) => activeSet.has(name));
	const allNameSet = new Set(allNames);
	for (const name of activeSet) {
		if (!allNameSet.has(name)) activeNames.push(name);
	}
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

function createGitCache(
	getSnapshot: () => TuiFooterSnapshot,
	setSnapshot: (snapshot: TuiFooterSnapshot) => void,
): GitSegmentCache {
	return new GitSegmentCache((cwd, git) => {
		const current = getSnapshot();
		if (current.cwd !== cwd) return;
		const next: TuiFooterSnapshot = { ...current };
		if (git === undefined) delete next.git;
		else next.git = git;
		setSnapshot(next);
	});
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
