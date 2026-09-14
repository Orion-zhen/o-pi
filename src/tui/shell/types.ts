import type { ContextUsage, ThemeColor } from "@earendil-works/pi-coding-agent";

/** TUI 状态图标来源。 */
export type TuiIconMode = "unicode" | "ascii" | "nerd";

/** Pi 工作指示器样式；off 会隐藏内置 streaming indicator。 */
type TuiWorkingIndicator = "dot" | "spinner" | "off";

/** footer 支持的字段；缺少数据时字段会自动隐藏。 */
type TuiFooterSegment = "cwd" | "git" | "ctx" | "tokens" | "cost";

/** Home 动效等级；playful 增加入场动画和 Home 存续期间的低频 Core 轨道。 */
type TuiHomeMotion = "off" | "subtle" | "playful";

/** Home 鼠标反馈；click-hold 在点击反馈外增加长按蓄力和释放爆炸。 */
export type TuiHomePointerEffects = "off" | "click" | "click-hold";

/** chrome 配置只控制 Pi 公开 UI API 暴露的轻量区域。 */
interface TuiChromeConfig {
	title: boolean;
	header: boolean;
	footer: boolean;
	working_indicator: TuiWorkingIndicator;
}

/** footer 在宽屏和窄屏下使用不同字段集合；工具状态固定占第二行。 */
export interface TuiFooterConfig {
	segments: TuiFooterSegment[];
	narrow_segments: TuiFooterSegment[];
	style: TuiFooterStyleConfig;
}

/** 页脚工作区与 Git 的 Pi 主题色配置。 */
interface TuiFooterStyleConfig {
	workspace_color: ThemeColor;
	git_color: ThemeColor;
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
	icons: TuiIconMode;
	chrome: TuiChromeConfig;
	footer: TuiFooterConfig;
	home: TuiHomeConfig;
	math: TuiMathConfig;
}

export type TuiRunStatus = "ready" | "running" | "waiting";

/** 活动会话的界面快照，供标题、Home、输入框和页脚共同读取。 */
export interface TuiSnapshot {
	cwd: string;
	sessionName?: string;
	hasPendingMessages: boolean;
	git?: string;
	modelId?: string;
	modelProvider?: string;
	modelReasoning?: boolean;
	thinkingLevel: string;
	availableProviderCount: number;
	context?: ContextUsage;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	latestCacheHitRate?: number;
	totalCacheHitRate?: number;
	costUsd?: number;
	usingSubscription?: boolean;
	status: TuiRunStatus;
	tools: TuiToolsSnapshot;
	skills?: TuiSkillsSnapshot;
}

/** 工具启用子集与全集均按注册顺序排列。 */
export interface TuiToolsSnapshot {
	activeNames: string[];
	allNames: string[];
}

/** Home 的 skill 快照；与 tools 分开统计。 */
export interface TuiSkillsSnapshot {
	totalCount: number;
	modelInvocableCount: number;
}
