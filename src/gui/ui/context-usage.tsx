import { Popover } from "radix-ui";
import type { GuiSnapshot } from "../contract.ts";
import { IconButton } from "./components/icon-button";

export function ContextUsage({ snapshot }: { snapshot: GuiSnapshot }) {
	const tokens = snapshot.context?.tokens;
	const capacity = snapshot.context?.contextWindow ?? snapshot.model?.contextWindow;
	const percent = snapshot.context?.percent;
	const usage = percent == null ? "待估算" : `${percent.toFixed(1)}%`;
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
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
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content className="context-details" side="top" align="end" sideOffset={6} collisionPadding={8} aria-label="上下文详情">
					<strong>上下文占用 {usage}</strong>
					<dl>
						<div><dt>已用 tokens</dt><dd>{tokens == null ? "待估算" : tokens.toLocaleString()}</dd></div>
						<div><dt>上下文容量</dt><dd>{capacity == null ? "未选择模型" : capacity.toLocaleString()}</dd></div>
						<div><dt>已启用工具</dt><dd>{snapshot.tools.filter((tool) => tool.enabled).length}</dd></div>
						<div><dt>累计 tokens</dt><dd>{snapshot.stats.tokens.total.toLocaleString()}</dd></div>
						<div><dt>预估费用</dt><dd>${snapshot.stats.cost.toFixed(4)}</dd></div>
					</dl>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
