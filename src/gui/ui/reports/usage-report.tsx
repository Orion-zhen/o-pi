import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import type { ProviderUsage, ProviderUsageData, UsageProviderError, UsageResetCredits, UsageSnapshot } from "../../../harness/usage/types.ts";
import { Bar, dateTime, Empty, Facts, Metrics, number, percent, ReportStamp, Section } from "./shared.tsx";

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

export function UsageReport({ value, onRefresh, disabled }: {
	value: UsageSnapshot | "aborted";
	onRefresh?: () => Promise<void>;
	disabled?: boolean;
}) {
	const [refreshing, setRefreshing] = useState(false);
	const refresh = async (load: () => Promise<void>) => {
		setRefreshing(true);
		try { await load(); }
		finally { setRefreshing(false); }
	};
	if (value === "aborted") return <div className="report-dashboard"><Empty>用量情况查询已取消。</Empty></div>;
	const providers = value.providers;
	return <div className="report-dashboard">
		{providers.length === 0 && <Empty>暂无已配置的套餐或 API 余额服务。</Empty>}
		{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} timeZone={value.timeZone} generatedAt={value.generatedAt} />)}
		<div className="usage-report-footer">
			<ReportStamp at={value.generatedAt} timeZone={value.timeZone} />
			{onRefresh && <Button variant="outline" size="sm" disabled={disabled || refreshing} onClick={() => void refresh(onRefresh)}>
				<RefreshCw aria-hidden="true" />{refreshing ? "刷新中…" : "刷新"}
			</Button>}
		</div>
	</div>;
}

function ProviderCard({ provider, timeZone, generatedAt }: { provider: ProviderUsage; timeZone: string; generatedAt: string }) {
	return <Section title={provider.name}>
		{provider.status === "error" ? <p className="report-message" data-tone="danger" role="status">{errorText(provider.error)}</p>
			: provider.kind === "balance" ? <ApiBalance value={provider} />
				: <PlanUsage value={provider} timeZone={timeZone} generatedAt={generatedAt} />}
	</Section>;
}

function PlanUsage({ value, timeZone, generatedAt }: { value: Extract<ProviderUsageData, { kind: "plan" }>; timeZone: string; generatedAt: string }) {
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
		{value.resetCredits !== undefined && <ResetCredits value={value.resetCredits} timeZone={timeZone} generatedAt={generatedAt} />}
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

function ResetCredits({ value, timeZone, generatedAt }: { value: UsageResetCredits; timeZone: string; generatedAt: string }) {
	return <section className="reset-credits" aria-label="重置额度">
		<header><h4>重置额度</h4><span>{number(value.availableCount)} 次可用</span></header>
		{value.credits === undefined ? <Empty>服务商未提供重置额度明细。</Empty>
			: value.credits.length === 0 ? <Empty>暂无重置额度记录。</Empty>
			: <ol>{value.credits.map((credit, index) => <li key={index}>
				{credit.status !== "available" && <span className="reset-credit-status">{credit.status}</span>}
				<dl>
					<div><dt>发放时间</dt><dd>{credit.grantedAt === undefined ? "未提供" : <time dateTime={credit.grantedAt}>{dateTime(credit.grantedAt, timeZone)}</time>}</dd></div>
					<div><dt>到期时间</dt><dd>{credit.expiresAt === undefined ? "无到期时间" : <time dateTime={credit.expiresAt}>{dateTime(credit.expiresAt, timeZone)}</time>}</dd></div>
					<div className="reset-credit-remaining"><dt>距到期</dt><dd>{expiryDistance(credit.expiresAt, generatedAt)}</dd></div>
				</dl>
			</li>)}</ol>}
	</section>;
}
