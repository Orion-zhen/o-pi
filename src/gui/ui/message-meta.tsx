import type { replyMetrics } from "../message-metrics.ts";

export function MessageIdentity({ name, timestamp }: { name: string; timestamp: number }) {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return <header className="message-identity"><strong>{name}</strong><time dateTime={date.toISOString()}>{time}</time></header>;
}

export function ReplyMetrics({ metrics }: { metrics: ReturnType<typeof replyMetrics> }) {
	const number = (value: number) => value.toLocaleString("en-US");
	return <footer className="reply-metrics" aria-label="本轮消息统计">
		<span>输入 {number(metrics.input)}</span>
		<span>输出 {number(metrics.output)}</span>
		<span>缓存读取 {number(metrics.cacheRead)}</span>
		<span>缓存写入 {number(metrics.cacheWrite)}</span>
		<span title="按模型定价估算的美元费用">${metrics.cost.toFixed(4)}</span>
		<span title="本轮输出 tokens / 模型请求耗时，含首字等待，不含工具执行">速度 {metrics.speed === null ? "—" : `${metrics.speed.toFixed(1)} tok/s`}</span>
	</footer>;
}
