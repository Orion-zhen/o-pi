import { Check, Flame, LoaderCircle } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { UsageResetCredits } from "../../../harness/usage/types.ts";
import { Button } from "../components/ui/button";
import { Hint } from "../components/ui/tooltip";
import { useConfirmation } from "../components/use-confirmation.ts";
import { dateTime, Empty, number } from "./shared.tsx";

export interface ResetCreditAction {
	use(creditId: string): Promise<void>;
	disabled: boolean;
	pendingId: string | undefined;
}

function expiryDistance(expiresAt: string | undefined, generatedAt: string): string {
	if (expiresAt === undefined) return "无到期时间";
	const ms = Date.parse(expiresAt) - Date.parse(generatedAt);
	if (ms <= 0) return "已到期";
	const minutes = Math.floor(ms / 60000);
	if (minutes === 0) return "不足 1 分钟";
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days} 天 ${hours % 24} 小时`;
	if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`;
	return `${minutes} 分钟`;
}

export function ResetCredits({ value, timeZone, generatedAt, action }: {
	value: UsageResetCredits;
	timeZone: string;
	generatedAt: string;
	action: ResetCreditAction | undefined;
}) {
	const confirmation = useConfirmation();
	const activate = (id: string, control: ResetCreditAction) => {
		if (confirmation.armed !== id) { confirmation.arm(id); return; }
		confirmation.cancel();
		void control.use(id);
	};
	return <section className="reset-credits" aria-label="重置额度">
		<header><h4>重置额度</h4><span>{number(value.availableCount)} 次可用</span></header>
		{value.credits === undefined ? <Empty>服务商未提供重置额度明细。</Empty>
			: value.credits.length === 0 ? <Empty>暂无重置额度记录。</Empty>
				: <ol>{value.credits.map((credit, index) => {
					const id = credit.id;
					const confirming = id !== undefined && confirmation.armed === id;
					const pending = id !== undefined && action?.pendingId === id;
					const expired = credit.expiresAt !== undefined && Date.parse(credit.expiresAt) <= Date.parse(generatedAt);
					return <li className="reset-credit-row" key={id ?? index}>
						{credit.status !== "available" && <span className="reset-credit-status">{credit.status}</span>}
						<dl><dt>发放时间</dt><dd><time dateTime={credit.grantedAt}>{dateTime(credit.grantedAt, timeZone)}</time></dd></dl>
						<dl><dt>到期时间</dt><dd>{credit.expiresAt === undefined ? "无到期时间" : <time dateTime={credit.expiresAt}>{dateTime(credit.expiresAt, timeZone)}</time>}</dd></dl>
						<dl className="reset-credit-remaining"><dt>距到期</dt><dd>{expiryDistance(credit.expiresAt, generatedAt)}</dd></dl>
						{action && id !== undefined && <Hint content={confirming ? "确定消耗这张重置卡" : "使用这张重置卡"} disabled={action.disabled}><Button
							ref={confirming ? confirmation.button : undefined}
							variant="outline" size="sm" className="reset-credit-use"
							data-confirming={confirming || pending}
							disabled={action.disabled || credit.status !== "available" || expired || value.availableCount === 0}
							aria-busy={pending}
							onBlur={() => { if (confirming) confirmation.cancel(); }}
							onClick={() => activate(id, action)}
						>
							<MorphIcon icon={pending ? LoaderCircle : confirming ? Check : Flame} spring="smooth" size="1em"
								className={pending ? "animate-spin motion-reduce:animate-none" : undefined} />
							{pending ? "使用中" : confirming ? "确定" : "使用"}
						</Button></Hint>}
					</li>;
				})}</ol>}
	</section>;
}
