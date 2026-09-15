import type { ContextBreakdownItem, StatsSnapshot } from "../../../harness/stats/types.ts";
import { Bar, duration, Empty, Facts, Metrics, money, number, percent, ReportStamp, Section } from "./shared.tsx";

const contextLabels: Record<ContextBreakdownItem["id"], string> = {
	system: "系统提示词", tool_definitions: "工具定义", project_context: "项目上下文", subagents: "子代理",
	skills: "技能", conversation_history: "对话历史", tool_calls: "工具调用", tool_outputs: "工具输出",
	current_user: "当前用户输入", unknown_delta: "未归类开销",
};

export function StatsReport({ value }: { value: StatsSnapshot }) {
	const { session, usage, cache, context, tools } = value;
	const ranked = [...tools.byName].sort((a, b) => b.calls - a.calls);
	const maxCalls = Math.max(0, ...ranked.map((tool) => tool.calls));
	return <div className="report-dashboard">
		<div className="report-intro"><span className="report-badge">{session.status === "running" ? "运行中" : "会话快照"}</span><h2>{session.modelId ?? "尚未选择模型"}</h2><p>{session.modelProvider}{session.thinkingLevel && ` · 思考级别 ${session.thinkingLevel}`}</p></div>
		<Metrics items={[
			{ label: "累计 Token", value: number(usage.totalObservedTokens), hint: "会话中已记录的用量" },
			{ label: "估算费用", value: money(usage.costUsd), hint: session.usingSubscription ? "订阅套餐 · 非实际账单" : "USD · 非实际账单" },
			{ label: "用户轮次", value: number(session.userTurns) },
			{ label: "助手轮次", value: number(session.assistantTurns) },
		]} />
		<Section title="上下文窗口">
			<Bar label="上下文占用" value={context.percent} tone={context.percent != null && context.percent >= 80 ? "warning" : "accent"} />
			<Facts items={[["当前 Token", number(context.totalTokens)], ["窗口容量", number(context.contextWindow)], ["剩余 Token", number(context.remainingTokens)], ["计量方式", { exact: "精确", estimated: "估算", mixed: "精确总量 + 估算拆分" }[context.confidence]]]} />
			{context.items.length ? <div className="report-bars">{context.items.map((item) => <Bar key={item.id} label={contextLabels[item.id]} value={item.share} text={`${item.estimated ? "约 " : ""}${number(item.tokens)} Token · ${percent(item.share)}`} />)}</div> : <Empty>暂无上下文来源数据。</Empty>}
			<p className="report-note">来源拆分为估算值，可能与提供商记录的总量存在偏差。</p>
		</Section>
		<Section title="Token 与缓存">
			<div className="report-bars">{([
				["输入", usage.inputTokens], ["输出", usage.outputTokens], ["缓存读取", usage.cacheReadTokens], ["缓存写入", usage.cacheWriteTokens],
			] as const).map(([label, tokens]) => <Bar key={label} label={label} value={usage.totalObservedTokens > 0 ? tokens / usage.totalObservedTokens * 100 : undefined} text={`${number(tokens)} Token`} />)}</div>
			<Bar label="累计缓存命中率" value={cache.totalHitRate} tone="success" />
			<Facts items={[["最近缓存命中率", percent(cache.latestHitRate)], ["缓存读写比", number(cache.readWriteRatio)], ["最近一轮 Token", number(usage.lastTurnTokens)], ["每助手轮平均 Token", number(usage.averageTokensPerAssistantTurn)], ["最近一轮估算费用", money(usage.lastCostUsd)]]} />
		</Section>
		<Section title="工具调用排行">
			<Facts items={[["调用次数", number(tools.calls)], ["成功", number(tools.successes)], ["失败", number(tools.failures)], ["启用 / 可用工具", `${number(tools.activeCount)} / ${number(tools.totalCount)}`]]} />
			{ranked.length ? <div className="report-bars">{ranked.map((tool) => <Bar key={tool.name} label={tool.name} value={maxCalls > 0 ? tool.calls / maxCalls * 100 : undefined} text={`${number(tool.calls)} 次`} hint={[tool.failures === undefined ? undefined : `失败 ${number(tool.failures)}`, tool.durationMs === undefined ? undefined : `耗时 ${duration(tool.durationMs)}`, tool.outputChars === undefined ? undefined : `输出 ${number(tool.outputChars)} 字符`].filter(Boolean).join(" · ")} tone={tool.failures ? "warning" : "accent"} />)}</div> : <Empty>尚无工具调用。</Empty>}
		</Section>
		<Section title="会话详情" detail><Facts items={[["工作目录", session.cwd], ["Git", session.git], ["推理模型", session.modelReasoning === undefined ? undefined : session.modelReasoning ? "是" : "否"]].filter((item): item is [string, string] => item[1] !== undefined)} /></Section>
		<ReportStamp at={value.generatedAt} />
	</div>;
}
