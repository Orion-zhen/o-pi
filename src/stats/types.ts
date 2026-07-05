/** /stats 展示的当前会话只读快照。 */
export interface StatsSnapshot {
	session: SessionStats;
	usage: UsageStats;
	cache: CacheStats;
	context: ContextStats;
	tools: ToolStats;
	generatedAt: Date;
}

/** 会话、模型和运行状态；缺失字段由 renderer 隐藏。 */
export interface SessionStats {
	cwd?: string;
	git?: string;
	modelId?: string;
	modelProvider?: string;
	modelReasoning?: boolean;
	thinkingLevel?: string;
	usingSubscription?: boolean;
	status?: string;
	userTurns: number;
	assistantTurns: number;
}

/** 从 assistant usage 累加的 token 与成本；成本只作为估算展示。 */
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalObservedTokens: number;
	lastTurnTokens?: number;
	averageTokensPerAssistantTurn?: number;
	costUsd?: number;
	lastCostUsd?: number;
}

/** Prompt cache 命中率统计；命中率单位为百分比。 */
export interface CacheStats {
	latestHitRate?: number;
	totalHitRate?: number;
	readWriteRatio?: number;
}

/** 当前请求窗口 context 拆分；items 多为估算，confidence 标明整体可信度。 */
export interface ContextStats {
	totalTokens?: number;
	contextWindow?: number;
	percent?: number | null;
	remainingTokens?: number;
	confidence: "exact" | "estimated" | "mixed";
	items: ContextBreakdownItem[];
	notes: string[];
}

/** context 来源拆分项；estimated 为 true 时 renderer 使用 ~ 前缀。 */
export interface ContextBreakdownItem {
	id:
		| "system"
		| "tool_definitions"
		| "project_context"
		| "subagents"
		| "conversation_history"
		| "tool_calls"
		| "tool_outputs"
		| "current_user"
		| "unknown_delta";
	label: string;
	tokens?: number;
	share?: number;
	estimated: boolean;
	note?: string;
}

/** 工具启用与调用统计；调用数据来自公开 session message。 */
export interface ToolStats {
	activeCount?: number;
	totalCount?: number;
	calls: number;
	successes?: number;
	failures?: number;
	byName: Array<{
		name: string;
		calls: number;
		failures?: number;
		durationMs?: number;
		outputChars?: number;
	}>;
}
