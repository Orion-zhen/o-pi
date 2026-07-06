import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStartupBannerComponent } from "../../src/tui/banner.js";
import { createHeaderComponent, formatTitle, workingIndicatorOptions } from "../../src/tui/chrome.js";
import { loadTuiConfig } from "../../src/tui/config.js";
import { createFooterComponent, GitSegmentCache } from "../../src/tui/footer.js";
import type { TuiConfig, TuiFooterSkillsSnapshot, TuiFooterSnapshot, TuiFooterToolsSnapshot } from "../../src/tui/types.js";

const STATUS_KEY = "o-pi:tui";

/** 注册 o-pi TUI V1：只使用 Pi 公开 UI API，不替换主 TUI 或 input editor。 */
export default function tuiExtension(pi: ExtensionAPI): void {
	let config: TuiConfig | undefined;
	let snapshot: TuiFooterSnapshot = {};
	let setTitle: ((title: string) => void) | undefined;
	let gitCache: GitSegmentCache | undefined;
	let startupBannerVisible = false;

	pi.on("session_start", async (_event, ctx) => {
		gitCache?.dispose();
		gitCache = createGitCache(() => snapshot, (next) => {
			snapshot = next;
			refreshTitle();
		});
		config = await loadTuiConfig();
		snapshot = makeSnapshot(ctx, pi, "ready", gitCache.get(ctx.cwd));
		setTitle = (title) => ctx.ui.setTitle(title);
		if (!config.enabled) {
			startupBannerVisible = false;
			cleanup(ctx);
			return;
		}
		applyChrome(ctx, config, () => snapshotWithCapabilities(snapshot, pi));
		if (config.banner.enabled) {
			startupBannerVisible = true;
			ctx.ui.setHeader(createStartupBannerComponent(config.banner, () => snapshotWithCapabilities(snapshot, pi)));
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "running", gitCache?.get(ctx.cwd));
		if (startupBannerVisible && config.banner.clear_on_first_turn) {
			startupBannerVisible = false;
			ctx.ui.setHeader(config.chrome.header ? createHeaderComponent(() => snapshotWithCapabilities(snapshot, pi)) : undefined);
		}
		gitCache?.refresh(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "● running"));
		refreshTitle();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!config?.enabled) return;
		snapshot = makeSnapshot(ctx, pi, "ready", gitCache?.get(ctx.cwd));
		gitCache?.refresh(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "✓ ready"));
		refreshTitle();
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

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanup(ctx);
		gitCache?.dispose();
		gitCache = undefined;
		config = undefined;
		setTitle = undefined;
		startupBannerVisible = false;
		snapshot = {};
	});

	function refreshTitle(): void {
		if (config?.chrome.title === true && setTitle !== undefined) setTitle(formatTitle(snapshot));
	}

	function cleanup(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setHeader(undefined);
		ctx.ui.setWorkingIndicator();
		if (ctx.cwd) ctx.ui.setTitle(formatTitle({ cwd: ctx.cwd, status: "ready" }));
	}
}

function applyChrome(ctx: ExtensionContext, config: TuiConfig, getSnapshot: () => TuiFooterSnapshot): void {
	if (config.chrome.title) ctx.ui.setTitle(formatTitle(getSnapshot()));
	ctx.ui.setWorkingIndicator(workingIndicatorOptions(config, ctx.ui.theme));
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "✓ ready"));
	ctx.ui.setFooter(config.chrome.footer ? createFooterComponent(config.footer, getSnapshot) : undefined);
	ctx.ui.setHeader(config.chrome.header ? createHeaderComponent(getSnapshot) : undefined);
}

function snapshotWithCapabilities(snapshot: TuiFooterSnapshot, pi: ExtensionAPI): TuiFooterSnapshot {
	const skills = collectSkills(pi);
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

/** 从 Pi 公开命令列表统计 skill 命令，不依赖 system prompt，也不计入工具数量。 */
function collectSkills(pi: ExtensionAPI): TuiFooterSkillsSnapshot | undefined {
	const skillCommands = pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.filter((command) => command.name.length > 0);
	const uniqueByName = new Map(skillCommands.map((command) => [command.name, command.sourceInfo.scope] as const));
	let userCount = 0;
	let projectCount = 0;
	let temporaryCount = 0;
	for (const scope of uniqueByName.values()) {
		if (scope === "user") userCount += 1;
		else if (scope === "project") projectCount += 1;
		else temporaryCount += 1;
	}
	const totalCount = uniqueByName.size;
	return totalCount > 0 ? { totalCount, userCount, projectCount, temporaryCount } : undefined;
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
