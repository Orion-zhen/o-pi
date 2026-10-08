import { memo } from "react";
import { Hint } from "../components/ui/tooltip";
import type { replyMetrics } from "../../message-metrics.ts";

export const MessageIdentity = memo(function MessageIdentity({ name, timestamp }: { name: string; timestamp: number }) {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return <header className="message-identity"><strong>{name}</strong><time dateTime={date.toISOString()}>{time}</time></header>;
});

export const ReplyMetrics = memo(function ReplyMetrics({ scope = "本轮", ...metrics }: ReturnType<typeof replyMetrics> & { scope?: "本轮" | "本条" }) {
	const number = (value: number) => value.toLocaleString("en-US");
	return <footer className="reply-metrics" aria-label={`${scope}消息统计`}>
		<span>输入 {number(metrics.input)}</span>
		<span>输出 {number(metrics.output)}</span>
		<span>缓存读取 {number(metrics.cacheRead)}</span>
		<span>缓存写入 {number(metrics.cacheWrite)}</span>
		<Hint content="预估费用 · USD"><span>${metrics.cost.toFixed(4)}</span></Hint>
		<Hint content="输出速度 · 含首字等待"><span aria-description={`${scope}输出 tokens / 模型请求耗时，不含工具执行`}>速度 {metrics.speed === null ? "—" : `${metrics.speed.toFixed(1)} tok/s`}</span></Hint>
	</footer>;
});
