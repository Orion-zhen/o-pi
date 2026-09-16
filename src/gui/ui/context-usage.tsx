import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import type { GuiSnapshot } from "../contract.ts";
import { summarizeUsage } from "../../harness/stats/usage.ts";
import { IconButton } from "./components/icon-button";

export function ContextUsage({ snapshot }: { snapshot: GuiSnapshot }) {
	const tokens = snapshot.context?.tokens;
	const capacity = snapshot.context?.contextWindow ?? snapshot.model?.contextWindow;
	const percent = snapshot.context?.percent;
	const usage = percent == null ? "待估算" : `${percent.toFixed(1)}%`;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<IconButton label={`上下文占用 ${usage}`} className="context-usage">
					<svg className="size-5" viewBox="0 0 24 24" fill="none" strokeWidth="2" aria-hidden="true">
						<circle className="context-ring-track" cx="12" cy="12" r="9" />
						{percent != null && (
							<circle
								cx="12"
								cy="12"
								r="9"
								stroke="currentColor"
								pathLength="100"
								strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`}
								transform="rotate(-90 12 12)"
							/>
						)}
					</svg>
				</IconButton>
			</PopoverTrigger>
				<PopoverContent className="context-details" side="top" align="end" sideOffset={6} collisionPadding={8} aria-label="上下文详情">
					<strong>上下文占用 {usage}</strong>
					<dl>
						<div><dt>已用 tokens</dt><dd>{tokens == null ? "待估算" : tokens.toLocaleString()}</dd></div>
						<div><dt>上下文容量</dt><dd>{capacity == null ? "未选择模型" : capacity.toLocaleString()}</dd></div>
						<div><dt>已启用工具</dt><dd>{snapshot.tools.filter((tool) => tool.enabled).length}</dd></div>
						<div><dt>累计 tokens</dt><dd>{snapshot.stats.tokens.total.toLocaleString()}</dd></div>
						<div><dt>预估费用</dt><dd>${snapshot.stats.cost.toFixed(4)}</dd></div>
					</dl>
					<ContextCache messages={snapshot.messages} />
				</PopoverContent>
		</Popover>
	);
}

function ContextCache({ messages }: Pick<GuiSnapshot, "messages">) {
	const { usage, cache } = summarizeUsage(messages);
	const hitRate = (value: number | undefined) => value === undefined ? "暂无数据" : `${value.toFixed(1)}%`;
	return <>
		<strong>缓存命中</strong>
		<dl>
			<div><dt>最近命中率</dt><dd>{hitRate(cache.latestHitRate)}</dd></div>
			<div><dt>累计命中率</dt><dd>{hitRate(cache.totalHitRate)}</dd></div>
			<div><dt>缓存读取 tokens</dt><dd>{usage.cacheReadTokens.toLocaleString()}</dd></div>
			<div><dt>缓存写入 tokens</dt><dd>{usage.cacheWriteTokens.toLocaleString()}</dd></div>
		</dl>
	</>;
}
