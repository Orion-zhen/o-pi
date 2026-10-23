import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/ui/button.tsx";
import type { GuiUsageResetResult } from "../../../shared/protocol/actions.ts";
import type { ProviderUsage, ProviderUsageData, UsageProviderError, UsageResetOutcome, UsageSnapshot } from "../../../../harness/usage/types.ts";
import { Bar, dateTime, Empty, Facts, Metrics, percent, ReportStamp, Section } from "./shared.tsx";
import { ResetCredits, type ResetCreditAction } from "./reset-credits.tsx";

function errorText(error: UsageProviderError): string {
	switch (error.code) {
		case "auth": return "认证失败，请检查凭据或重新登录。";
		case "timeout": return "查询超时，请稍后重试。";
		case "http": return `服务商返回 HTTP ${error.httpStatus}，请稍后重试。`;
		case "response_too_large": return "服务商响应过大，无法读取用量。";
		case "invalid_response": return "服务商返回了无法识别的用量数据。";
		case "request_failed": return "查询失败，请检查网络后重试。";
	}
}

const resetMessages: Record<UsageResetOutcome, string> = {
	reset: "重置卡已使用，Codex 额度已重置。",
	already_redeemed: "这次请求已处理，无需重复消耗重置卡。",
	nothing_to_reset: "当前没有需要重置的额度，未消耗重置卡。",
	no_credit: "这张重置卡已不可用，请查看最新卡片列表。",
};
type Operation = { kind: "refresh" } | { kind: "use"; creditId: string };

export function UsageReport({ value, onRefresh, onUse, disabled }: {
	value: UsageSnapshot | "aborted";
	onRefresh: () => Promise<void>;
	onUse: (creditId: string, requestId: string) => Promise<GuiUsageResetResult>;
	disabled: boolean;
}) {
	const [operation, setOperation] = useState<Operation>();
	const [message, setMessage] = useState<{ text: string; tone: "success" | "warning" }>();
	// 请求 ID 与面板同寿命，不随服务商查询失败而丢失。
	const requests = useRef(new Map<string, string>());
	const run = async (next: Operation, task: () => Promise<void>) => {
		setOperation(next);
		setMessage(undefined);
		try { await task(); }
		catch (error) { setMessage({ text: error instanceof Error ? error.message : String(error), tone: "warning" }); }
		finally { setOperation(undefined); }
	};
	const useCredit = (creditId: string) => run({ kind: "use", creditId }, async () => {
		const requestId = requests.current.get(creditId) ?? crypto.randomUUID();
		requests.current.set(creditId, requestId);
		const { outcome, refreshed } = await onUse(creditId, requestId);
		// 明确的兑换结果决定是否更换请求 ID，刷新失败不改变兑换结果。
		requests.current.delete(creditId);
		setMessage({
			text: resetMessages[outcome] + (refreshed ? "" : " 用量刷新失败，请刷新后查看最新额度。"),
			tone: refreshed && (outcome === "reset" || outcome === "already_redeemed") ? "success" : "warning",
		});
	});
	const actionDisabled = Boolean(disabled || operation);
	const resetAction = { use: useCredit, pendingId: operation?.kind === "use" ? operation.creditId : undefined, disabled: actionDisabled };
	return <div className="report-dashboard">
		{value === "aborted" ? <Empty>用量情况查询已取消。</Empty> : <>
			{value.providers.length === 0 && <Empty>暂无已配置的套餐或 API 余额服务。</Empty>}
			{value.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} timeZone={value.timeZone} generatedAt={value.generatedAt} resetAction={resetAction} />)}
		</>}
		{message && <p className="report-message" data-tone={message.tone} role="status">{message.text}</p>}
		<div className="usage-report-footer">
			{value !== "aborted" && <ReportStamp at={value.generatedAt} timeZone={value.timeZone} />}
			<Button variant="outline" size="sm" disabled={actionDisabled} onClick={() => void run({ kind: "refresh" }, onRefresh)}>
				<RefreshCw aria-hidden="true" />{operation?.kind === "refresh" ? "刷新中…" : "刷新"}
			</Button>
		</div>
	</div>;
}

function ProviderCard({ provider, timeZone, generatedAt, resetAction }: { provider: ProviderUsage; timeZone: string; generatedAt: string; resetAction: ResetCreditAction }) {
	return <Section title={provider.name}>
		{provider.status === "error" ? <p className="report-message" data-tone="danger" role="status">{errorText(provider.error)}</p>
			: provider.kind === "balance" ? <ApiBalance value={provider} /> : <>
				<PlanUsage value={provider} timeZone={timeZone} />
				{provider.resetCredits !== undefined && <ResetCredits value={provider.resetCredits} timeZone={timeZone} generatedAt={generatedAt} action={provider.id === "openai-codex" ? resetAction : undefined} />}
			</>}
	</Section>;
}

function PlanUsage({ value, timeZone }: { value: Extract<ProviderUsageData, { kind: "plan" }>; timeZone: string }) {
	return <>
		<div className="report-inline"><span className="report-badge" data-tone="success">已连接</span><strong>{value.plan ?? "套餐名称未提供"}</strong></div>
		{value.windows.length === 0 ? <Empty>服务商暂未提供额度窗口。</Empty> : <div className="report-bars">{value.windows.map((window, index) => {
			const remaining = window.usedPercent === undefined ? undefined : 100 - window.usedPercent;
			return <div className="report-usage-window" key={index}>
				<Bar label={[window.sectionLabel, window.label].filter(Boolean).join(" · ")} value={remaining} text={remaining === undefined ? "用量暂不可用" : `剩余 ${percent(remaining)}`} tone={remaining === undefined || remaining > 20 ? "success" : remaining > 5 ? "warning" : "danger"} />
				<dl className="usage-reset">
					<dt>重置时间</dt>
					<dd>{window.resetsAt === undefined ? "未提供" : <time dateTime={window.resetsAt}>{dateTime(window.resetsAt, timeZone)}</time>}</dd>
				</dl>
			</div>;
		})}</div>}
		{value.details.length > 0 && <Facts items={value.details.map((detail) => [detail.label, detail.value])} />}
	</>;
}

function ApiBalance({ value }: { value: Extract<ProviderUsageData, { kind: "balance" }> }) {
	return <>
		<div className="report-inline"><span className="report-badge" data-tone="success">已连接</span><strong>API 余额</strong></div>
		{value.balances.length === 0 ? <Empty>服务商未提供余额明细。</Empty> : value.balances.map((balance, index) => <div className="usage-balance" key={index}>
			<Metrics items={[{ label: "可用余额", value: `${balance.currency} ${balance.total}` }]} />
			<div className="usage-balance-details">
				<Facts items={[["充值余额", `${balance.currency} ${balance.toppedUp}`]]} />
				<Facts items={[["赠金余额", `${balance.currency} ${balance.granted}`]]} />
			</div>
		</div>)}
		{!value.isAvailable && <p className="report-message" data-tone="warning" role="status">余额不足，暂不可调用 API。</p>}
	</>;
}
