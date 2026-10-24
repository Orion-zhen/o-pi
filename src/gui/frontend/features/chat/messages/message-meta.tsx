import { memo } from "react";
import { Hint } from "@/ui/tooltip.tsx";
import type { replyMetrics } from "./metrics.ts";

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
	</footer>;
});

export const GenerationSpeed = memo(function GenerationSpeed({ speed }: { speed: number | null }) {
	return <Hint content="本段正文生成速度估算 · 不含首字等待"><span className="generation-speed" aria-description="本段正文 tokens 减去首片段 tokens，除以首末片段到达间隔">速度 {speed === null ? "—" : `${speed.toFixed(1)} tok/s`}</span></Hint>;
});
