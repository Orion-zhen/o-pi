import type { ContextUsage, ThemeColor } from "@earendil-works/pi-coding-agent";

/** TUI 状态图标来源；auto 在 V1 中等同 unicode，保留给字体探测入口。 */
export type TuiIconMode = "unicode" | "ascii" | "nerd" | "auto";

/** o-pi TUI 预设；compact 保留更多状态，minimal 只显示核心 chrome。 */
export type TuiPreset = "compact" | "minimal";

/** Pi 工作指示器样式；off 会隐藏内置 streaming indicator。 */
export type TuiWorkingIndicator = "dot" | "spinner" | "off";

/** footer 支持的字段；缺少数据时字段会自动隐藏。 */
export type TuiFooterSegment = "cwd" | "git" | "ctx" | "tokens" | "cost";

/** Home 动效等级；playful 增加输入反馈和 Home 存续期间的低频 Core 轨道。 */
export type TuiHomeMotion = "off" | "subtle" | "playful";

/** Home 鼠标反馈；click-hold 在点击反馈外增加长按蓄力和释放爆炸。 */
export type TuiHomePointerEffects = "off" | "click" | "click-hold";


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

/** 空会话启动 Home 配置；布局按终端宽高自动降级。 */
export interface TuiHomeConfig {
	enabled: boolean;
	motion: TuiHomeMotion;
	pointer_effects: TuiHomePointerEffects;
	show_tagline: boolean;
	show_tips: boolean;
	show_hints: boolean;
	show_capabilities: boolean;
}

/** Pi 原生 LaTeX 之上的块级公式图片增强配置。 */
export interface TuiMathConfig {
	enabled: boolean;
	max_width_cells: number;
	max_height_cells: number;
	svg_scale: number;
	foreground: string;
}

/** TUI 配置；缺失字段由 loader 合并默认值。 */
export interface TuiConfig {
	enabled: boolean;
	preset: TuiPreset;
	icons: TuiIconMode;
	chrome: TuiChromeConfig;
	footer: TuiFooterConfig;
	tools: TuiToolsConfig;
	home: TuiHomeConfig;
	math: TuiMathConfig;
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

/** Home 的 skill 快照；与 tools 分开统计。 */
export interface TuiFooterSkillsSnapshot {
	totalCount: number;
	modelInvocableCount: number;
}
