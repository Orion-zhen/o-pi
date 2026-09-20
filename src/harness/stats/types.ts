/** /stats 展示的当前会话只读快照。 */
export interface StatsSnapshot {
	session: SessionStats;
	usage: UsageStats;
	cache: CacheStats;
	context: ContextStats;
	tools: ToolStats;
	generatedAt: string;
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

/** 会话总用量包含后台请求，轮次指标只计 assistant。成本为估算值。 */
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
	cacheWarming?: { requests: number; tokens: number; costUsd: number };
}

/** 对话请求的缓存命中率，单位为百分比。不包含后台保温。 */
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
		| "skills"
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
