import path from "node:path";
import { execFile } from "node:child_process";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { truncateMiddle } from "./text.js";
import type { TuiFooterConfig, TuiFooterSegment, TuiFooterSnapshot } from "./types.js";

const GIT_TIMEOUT_MS = 80;
const NARROW_WIDTH = 80;

/** 异步 git 状态缓存；TUI 生命周期只读缓存，避免同步子进程阻塞渲染。 */
export type GitSegmentReader = (cwd: string, signal?: AbortSignal) => Promise<string | undefined>;

export class GitSegmentCache {
	private cwd: string | undefined;
	private segment: string | undefined;
	private inFlight: Promise<void> | undefined;
	private inFlightController: AbortController | undefined;
	private disposed = false;

	constructor(
		private readonly onChange: (cwd: string, segment: string | undefined) => void,
		private readonly readSegment: GitSegmentReader = readGitSegment,
	) {}

	get(cwd: string): string | undefined {
		if (this.cwd !== cwd) {
			this.cwd = cwd;
			this.segment = undefined;
			this.refresh(cwd);
		}
		return this.segment;
	}

	refresh(cwd: string): void {
		if (this.disposed || this.inFlight !== undefined) return;
		this.cwd = cwd;
		const controller = new AbortController();
		this.inFlightController = controller;
		this.inFlight = this.readSegment(cwd, controller.signal)
			.then((segment) => {
				if (this.disposed || this.cwd !== cwd) return;
				if (this.segment === segment) return;
				this.segment = segment;
				this.onChange(cwd, segment);
			})
			.finally(() => {
				if (this.inFlightController === controller) this.inFlightController = undefined;
				if (this.inFlight !== undefined && this.inFlightController === undefined) this.inFlight = undefined;
			});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.inFlightController?.abort();
		this.inFlightController = undefined;
		const pending = this.inFlight;
		if (pending !== undefined) await pending.catch(() => undefined);
	}
}

/** 用安全 git 子进程异步读取分支；失败返回 undefined，footer 自动隐藏该字段。 */
export async function readGitSegment(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const [branch, dirty] = await Promise.all([
		execGit(cwd, ["branch", "--show-current"], signal),
		execGit(cwd, ["status", "--porcelain"], signal),
	]);
	if (branch === undefined || dirty === undefined) return undefined;
	const cleanBranch = branch.trim();
	const isDirty = dirty.trim().length > 0;
	if (cleanBranch.length === 0) return isDirty ? "detached*" : "detached";
	return `${cleanBranch}${isDirty ? "*" : ""}`;
}

function execGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) }, (error, stdout) => {
			resolve(error === null ? stdout : undefined);
		});
	});
}

/** 生成 footer 行；第一行保留原状态，第二行展示工具启用概览。 */
export function formatFooter(snapshot: TuiFooterSnapshot, config: TuiFooterConfig, width: number, theme?: Pick<Theme, "fg">): string[] {
	const segments = width >= NARROW_WIDTH ? config.segments : config.narrow_segments;
	const primary = renderPrimaryLine(snapshot, segments, width, theme, config);
	const secondary = renderSecondaryLine(snapshot, segments, width, theme, config);
	return secondary === undefined ? [primary] : [primary, secondary];
}

/** 自定义 footer 组件只保存纯快照读取函数，不持有 ExtensionContext。 */
export class TuiFooterComponent implements Component {
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly config: TuiFooterConfig,
		private readonly getSnapshot: () => TuiFooterSnapshot,
		private readonly ownStatusKey?: string,
		private readonly leftStatusKey?: string,
	) {
		this.unsubscribe = footerData.onBranchChange(() => {
			this.invalidate();
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const snapshot = this.withFooterData(this.getSnapshot());
		return formatFooter(snapshot, this.config, width, this.theme);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private withFooterData(snapshot: TuiFooterSnapshot): TuiFooterSnapshot {
		const branch = this.footerData.getGitBranch();
		const statuses = this.footerData.getExtensionStatuses();
		const ownStatus = this.ownStatusKey === undefined ? undefined : statuses.get(this.ownStatusKey);
		const leftStatus = this.leftStatusKey === undefined ? undefined : statuses.get(this.leftStatusKey);
		return {
			...snapshot,
			...(snapshot.git !== undefined ? {} : branch !== null ? { git: branch } : {}),
			availableProviderCount: this.footerData.getAvailableProviderCount(),
			...(snapshot.status === undefined && ownStatus !== undefined && ownStatus.length > 0 ? { status: ownStatus } : {}),
			...(leftStatus !== undefined && leftStatus.length > 0 ? { extensionStatus: leftStatus } : {}),
		};
	}
}

export function createFooterComponent(
	config: TuiFooterConfig,
	getSnapshot: () => TuiFooterSnapshot,
	ownStatusKey?: string,
	leftStatusKey?: string,
): (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void } {
	return (tui, theme, footerData) => new TuiFooterComponent(tui, theme, footerData, config, getSnapshot, ownStatusKey, leftStatusKey);
}

function renderSegments(
	snapshot: TuiFooterSnapshot,
	segments: TuiFooterSegment[],
	width: number,
	theme?: Pick<Theme, "fg">,
	config?: TuiFooterConfig,
): string {
	const parts = segments.map((segment) => renderSegment(snapshot, segment, width, theme, config)).filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join(dim(theme, " · "));
}

function renderPrimaryLine(
	snapshot: TuiFooterSnapshot,
	segments: TuiFooterSegment[],
	width: number,
	theme: Pick<Theme, "fg"> | undefined,
	config: TuiFooterConfig,
): string {
	const configuredLeft = renderSegments(snapshot, segments.filter(isLeftSegment), width, theme, config);
	const extensionStatus = dimOptional(theme, snapshot.extensionStatus);
	const left = extensionStatus === undefined
		? configuredLeft
		: configuredLeft.length === 0
			? extensionStatus
			: `${configuredLeft}${dim(theme, " · ")}${extensionStatus}`;
	const right = renderSegments(snapshot, segments.filter(isPrimaryRightSegment), width, theme, config);
	return alignLine(left, right, width);
}

function isLeftSegment(segment: TuiFooterSegment): boolean {
	return segment === "cwd" || segment === "git";
}

function isPrimaryRightSegment(segment: TuiFooterSegment): boolean {
	return segment === "model" || segment === "ctx" || segment === "status";
}

function renderSecondaryLine(
	snapshot: TuiFooterSnapshot,
	segments: TuiFooterSegment[],
	width: number,
	theme: Pick<Theme, "fg"> | undefined,
	config: TuiFooterConfig,
): string | undefined {
	const right = renderToolsCount(snapshot, theme);
	const rightWidth = right === undefined ? 0 : visibleWidth(right);
	const leftBudget = rightWidth === 0 ? width : Math.max(1, width - rightWidth - 1);
	const left = renderSecondarySegments(snapshot, segments.filter(isSecondaryLeftSegment), leftBudget, theme, config);
	if (left.length === 0 && right === undefined) return undefined;
	return alignLine(left, right ?? "", width);
}

function isSecondaryLeftSegment(segment: TuiFooterSegment): boolean {
	return segment === "tokens" || segment === "cost";
}

function renderToolsCount(snapshot: TuiFooterSnapshot, theme: Pick<Theme, "fg"> | undefined): string | undefined {
	const tools = snapshot.tools;
	if (tools === undefined) return undefined;
	const activeCount = new Set(tools.activeNames.filter((name) => name.length > 0)).size;
	const total = Math.max(0, tools.totalCount, activeCount);
	return dim(theme, `${activeCount}/${total} tools enabled`);
}

/** 第二行要先扣除 cost/tools 宽度，再让 token 段自适应，避免 cache 命中率被最终截断吞掉。 */
function renderSecondarySegments(
	snapshot: TuiFooterSnapshot,
	segments: TuiFooterSegment[],
	width: number,
	theme: Pick<Theme, "fg"> | undefined,
	config: TuiFooterConfig,
): string {
	const separator = dim(theme, " · ");
	const tokenIndex = segments.indexOf("tokens");
	if (tokenIndex === -1) return renderSegments(snapshot, segments, width, theme, config);

	const fixedParts = segments
		.filter((segment) => segment !== "tokens")
		.map((segment) => renderSegment(snapshot, segment, width, theme, config))
		.filter((part): part is string => part !== undefined && part.length > 0);
	const fixedWidth = fixedParts.reduce((sum, part) => sum + visibleWidth(part), 0);
	const separatorWidth = visibleWidth(separator) * fixedParts.length;
	const tokenBudget = Math.max(1, width - fixedWidth - separatorWidth);
	const parts = segments
		.map((segment) => renderSegment(snapshot, segment, segment === "tokens" ? tokenBudget : width, theme, config))
		.filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join(separator);
}

function alignLine(left: string, right: string, width: number): string {
	const maxWidth = Math.max(1, width);
	if (right.length === 0) return truncateToWidth(left, maxWidth, "…");
	if (left.length === 0) return truncateToWidth(right, maxWidth, "…");
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 1 <= maxWidth) {
		const gap = maxWidth - leftWidth - rightWidth;
		return `${left}${" ".repeat(Math.max(1, gap))}${right}`;
	}
	const leftMaxWidth = Math.min(leftWidth, Math.max(1, Math.floor((maxWidth - 1) * 0.55)));
	const rightMaxWidth = Math.max(1, maxWidth - leftMaxWidth - 1);
	const clippedLeft = truncateToWidth(left, leftMaxWidth, "…");
	const clippedRight = truncateToWidth(right, rightMaxWidth, "…");
	const gap = maxWidth - visibleWidth(clippedLeft) - visibleWidth(clippedRight);
	return `${clippedLeft}${" ".repeat(Math.max(1, gap))}${clippedRight}`;
}

function renderSegment(
	snapshot: TuiFooterSnapshot,
	segment: TuiFooterSegment,
	width: number,
	theme: Pick<Theme, "fg"> | undefined,
	config: TuiFooterConfig | undefined,
): string | undefined {
	if (segment === "cwd" && snapshot.cwd) {
		const workspace = truncateMiddle(formatWorkspace(snapshot.cwd), width > NARROW_WIDTH ? 40 : 22);
		return color(theme, config?.style.workspace_color, workspace);
	}
	if (segment === "git" && snapshot.git) {
		const icon = config?.style.git_icon ?? "⑂";
		return color(theme, config?.style.git_color, `${icon} ${snapshot.git}`);
	}
	if (segment === "model") return dimOptional(theme, formatModel(snapshot));
	if (segment === "ctx" && snapshot.context?.percent !== null && snapshot.context?.percent !== undefined) {
		return formatContext(snapshot, theme);
	}
	if (segment === "tokens") {
		return dimOptional(theme, formatTokenStats(snapshot, width));
	}
	if (segment === "cost" && (snapshot.costUsd !== undefined || snapshot.usingSubscription)) {
		return dim(theme, `$${(snapshot.costUsd ?? 0).toFixed(3)}${snapshot.usingSubscription ? " (sub)" : ""}`);
	}
	if (segment === "status") return dimOptional(theme, snapshot.status);
	return undefined;
}

/** 将 cwd 压缩为适合 TUI 的 workspace 文本，$HOME 下使用 ~。 */
export function formatWorkspace(cwd: string): string {
	const home = process.env["HOME"] || process.env["USERPROFILE"];
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const relativeToHome = path.relative(resolvedHome, resolvedCwd);
	const insideHome = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~/${relativeToHome.split(path.sep).join("/")}`;
}

/** 按 footer 规则格式化模型名；缺失模型时返回 undefined。 */
export function formatModel(snapshot: TuiFooterSnapshot): string | undefined {
	if (!snapshot.modelId) return undefined;
	let label = snapshot.modelId;
	if (snapshot.modelReasoning) {
		const thinking = snapshot.thinkingLevel || "off";
		label = thinking === "off" ? `${label} • thinking off` : `${label} • ${thinking}`;
	}
	if ((snapshot.availableProviderCount ?? 0) > 1 && snapshot.modelProvider) return `(${snapshot.modelProvider}) ${label}`;
	return label;
}

/** 按 footer 规则格式化 context 百分比和窗口大小。 */
export function formatContext(snapshot: TuiFooterSnapshot, theme: Pick<Theme, "fg"> | undefined): string | undefined {
	const usage = snapshot.context;
	if (!usage) return undefined;
	const contextWindow = usage.contextWindow || 0;
	const percentValue = usage.percent ?? 0;
	const percent = usage.percent === null ? "?" : percentValue.toFixed(1);
	const display = usage.percent === null ? `?/${formatTokens(contextWindow)}` : `${percent}%/${formatTokens(contextWindow)}`;
	if (theme === undefined) return display;
	if (usage.percent === null) return theme.fg("muted", display);
	return applyContextGradient(display, percentValue);
}

function formatTokenStats(snapshot: TuiFooterSnapshot, width: number): string | undefined {
	const ioParts = [snapshot.inputTokens ? `↑${formatTokens(snapshot.inputTokens)}` : undefined, snapshot.outputTokens ? `↓${formatTokens(snapshot.outputTokens)}` : undefined].filter(
		(part): part is string => part !== undefined,
	);
	const io = ioParts.join(" ");
	const cache = formatCacheStats(snapshot, width);
	if (cache === undefined) return io.length > 0 ? io : undefined;
	if (width < 44) return cache;
	const cacheFirst = [cache, io].filter((part) => part.length > 0).join(" ");
	if (width < 64) return cacheFirst;
	return [io, cache].filter((part) => part.length > 0).join(" ");
}

function formatCacheStats(snapshot: TuiFooterSnapshot, width: number): string | undefined {
	const hasCounts = snapshot.cacheReadTokens !== undefined || snapshot.cacheWriteTokens !== undefined;
	const hasRates = snapshot.latestCacheHitRate !== undefined || snapshot.totalCacheHitRate !== undefined;
	if (!hasCounts && !hasRates) return undefined;
	const counts = hasCounts ? [`R${formatTokens(snapshot.cacheReadTokens ?? 0)}`, `W${formatTokens(snapshot.cacheWriteTokens ?? 0)}`] : [];
	const rates = [
		snapshot.latestCacheHitRate !== undefined ? `hit ${snapshot.latestCacheHitRate.toFixed(1)}%` : undefined,
		snapshot.totalCacheHitRate !== undefined ? `total ${snapshot.totalCacheHitRate.toFixed(1)}%` : undefined,
	].filter((part): part is string => part !== undefined);
	if (width < 44 && rates.length > 0) return `cache ${rates.join(" ")}`;
	if (width < 64 && counts.length > 0) return `cache ${counts.join("/")} ${rates.join(" ")}`.trimEnd();
	return `cache ${[...counts, ...rates].join(" ")}`;
}

/** 将 token 数压缩为短文本。 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function color(theme: Pick<Theme, "fg"> | undefined, colorName: TuiFooterConfig["style"]["workspace_color"] | undefined, text: string): string {
	return theme && colorName ? theme.fg(colorName, text) : text;
}

function dim(theme: Pick<Theme, "fg"> | undefined, text: string): string {
	return theme ? theme.fg("dim", text) : text;
}

function dimOptional(theme: Pick<Theme, "fg"> | undefined, text: string | undefined): string | undefined {
	return text === undefined ? undefined : dim(theme, text);
}

function applyContextGradient(text: string, percent: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const [red, green, blue] = clamped <= 50
		? interpolateRgb([46, 204, 113], [241, 196, 15], clamped / 50)
		: interpolateRgb([241, 196, 15], [231, 76, 60], (clamped - 50) / 50);
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function interpolateRgb(from: [number, number, number], to: [number, number, number], ratio: number): [number, number, number] {
	return [
		Math.round(from[0] + (to[0] - from[0]) * ratio),
		Math.round(from[1] + (to[1] - from[1]) * ratio),
		Math.round(from[2] + (to[2] - from[2]) * ratio),
	];
}
