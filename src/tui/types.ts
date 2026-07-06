import type { ContextUsage, ThemeColor } from "@earendil-works/pi-coding-agent";

/** TUI 状态图标来源；auto 在 V1 中等同 unicode，保留给字体探测入口。 */
export type TuiIconMode = "unicode" | "ascii" | "nerd" | "auto";

/** o-pi TUI 预设；compact 保留更多状态，minimal 只显示核心 chrome。 */
export type TuiPreset = "compact" | "minimal";

/** Pi 工作指示器样式；off 会隐藏内置 streaming indicator。 */
export type TuiWorkingIndicator = "dot" | "spinner" | "off";

/** footer 支持的字段；缺少数据时字段会自动隐藏。 */
export type TuiFooterSegment = "cwd" | "git" | "model" | "ctx" | "tokens" | "cost" | "status";

/** startup banner 布局；auto 按终端宽度在三种布局间选择。 */
export type TuiBannerLayout = "auto" | "side_by_side" | "stacked" | "tiny";

/** startup banner 风格；compact 不渲染 ASCII wordmark。 */
export type TuiBannerStyle = "ascii" | "compact";

/** chrome 配置只控制 Pi 公开 UI API 暴露的轻量区域。 */
export interface TuiChromeConfig {
	title: boolean;
	header: boolean;
	footer: boolean;
	working_indicator: TuiWorkingIndicator;
}

/** footer 在宽屏和窄屏下使用不同字段集合；工具状态固定占第二行。 */
export interface TuiFooterConfig {
	max_lines: 2;
	segments: TuiFooterSegment[];
	narrow_segments: TuiFooterSegment[];
	style: TuiFooterStyleConfig;
}

/** footer 颜色和图标只使用 Pi theme token，不写死 ANSI。 */
export interface TuiFooterStyleConfig {
	workspace_color: ThemeColor;
	git_color: ThemeColor;
	git_icon: string;
}

/** 工具卡片固定 2 行；collapsed_lines 只允许 2，用于 schema 明确约束。 */
export interface TuiToolsConfig {
	expanded_default: boolean;
	show_timing: boolean;
	show_provider: boolean;
	max_target_chars: number;
	max_summary_chars: number;
	collapsed_lines: 2;
}

/** startup banner 配置；只通过 Pi 公开 header API 渲染。 */
export interface TuiBannerConfig {
	enabled: boolean;
	style: TuiBannerStyle;
	layout: TuiBannerLayout;
	side_by_side_min_width: number;
	tiny_width: number;
	show_hints: boolean;
	show_capabilities: boolean;
	clear_on_first_turn: boolean;
}

/** TUI V1 配置；缺失字段由 loader 合并默认值。 */
export interface TuiConfig {
	version: 1;
	enabled: boolean;
	preset: TuiPreset;
	icons: TuiIconMode;
	chrome: TuiChromeConfig;
	footer: TuiFooterConfig;
	tools: TuiToolsConfig;
	banner: TuiBannerConfig;
}

/** footer 渲染所需的纯数据快照，避免组件长期持有 ExtensionContext。 */
export interface TuiFooterSnapshot {
	cwd?: string;
	git?: string;
	modelId?: string;
	modelProvider?: string;
	modelReasoning?: boolean;
	thinkingLevel?: string;
	availableProviderCount?: number;
	context?: ContextUsage;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	latestCacheHitRate?: number;
	totalCacheHitRate?: number;
	costUsd?: number;
	usingSubscription?: boolean;
	status?: string;
	tools?: TuiFooterToolsSnapshot;
	skills?: TuiFooterSkillsSnapshot;
}

/** footer 工具启用快照；activeNames 按工具注册顺序显示，totalCount 用于概览。 */
export interface TuiFooterToolsSnapshot {
	activeNames: string[];
	totalCount: number;
	allNames?: string[];
}

/** startup banner 的 skill 快照；只用于独立 skills 行，不计入工具数量。 */
export interface TuiFooterSkillsSnapshot {
	totalCount: number;
	userCount: number;
	projectCount: number;
	temporaryCount: number;
}
