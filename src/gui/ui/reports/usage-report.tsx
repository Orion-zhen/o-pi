import type { ProviderUsage, UsageProviderError, UsageResetCredits, UsageSnapshot } from "../../../harness/usage/types.ts";
import { Bar, dateTime, Empty, Facts, number, percent, ReportStamp, Section } from "./shared.tsx";

function errorText(error: UsageProviderError): string {
	switch (error.code) {
		case "auth": return "认证失败，请重新登录该服务商。";
		case "timeout": return "查询超时，请稍后重试。";
		case "http": return `服务商返回 HTTP ${error.httpStatus}，请稍后重试。`;
		case "response_too_large": return "服务商响应过大，无法读取用量。";
		case "invalid_response": return "服务商返回了无法识别的用量数据。";
		case "request_failed": return "查询失败，请检查网络后重试。";
	}
}

export function UsageReport({ value }: { value: UsageSnapshot | "aborted" }) {
	if (value === "aborted") return <div className="report-dashboard"><Empty>套餐用量查询已取消。</Empty></div>;
	const providers = value.providers.filter((provider) => provider.status !== "not_logged_in");
	return <div className="report-dashboard">
		{providers.length === 0 && <Empty>暂无已登录的套餐。</Empty>}
		{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} timeZone={value.timeZone} generatedAt={value.generatedAt} />)}
		<ReportStamp at={value.generatedAt} timeZone={value.timeZone} />
	</div>;
}

function ProviderCard({ provider, timeZone, generatedAt }: { provider: Exclude<ProviderUsage, { status: "not_logged_in" }>; timeZone: string; generatedAt: string }) {
	return <Section title={provider.name}>
		{provider.status === "error" ? <p className="report-message" data-tone="danger" role="status">{errorText(provider.error)}</p>
			: <>
				<div className="report-inline"><span className="report-badge" data-tone="success">已连接</span><strong>{provider.plan ?? "套餐名称未提供"}</strong></div>
				{provider.windows.length === 0 ? <Empty>服务商暂未提供额度窗口。</Empty> : <div className="report-bars">{provider.windows.map((window, index) => {
					const remaining = window.usedPercent === undefined ? undefined : 100 - window.usedPercent;
					return <div className="report-usage-window" key={index}>
						<Bar label={[window.sectionLabel, window.label].filter(Boolean).join(" · ")} value={remaining} text={remaining === undefined ? "用量暂不可用" : `剩余 ${percent(remaining)}`} tone={remaining === undefined || remaining > 20 ? "success" : remaining > 5 ? "warning" : "danger"} />
						<dl className="usage-reset">
							<dt>重置时间</dt>
							<dd>{window.resetsAt === undefined ? "未提供" : <time dateTime={window.resetsAt}>{dateTime(window.resetsAt, timeZone)}</time>}</dd>
						</dl>
					</div>;
				})}</div>}
				{provider.details.length > 0 && <Facts items={provider.details.map((detail) => [detail.label, detail.value])} />}
				{provider.resetCredits !== undefined && <ResetCredits value={provider.resetCredits} timeZone={timeZone} generatedAt={generatedAt} />}
			</>}
	</Section>;
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

export function ResetCredits({ value, timeZone, generatedAt }: { value: UsageResetCredits; timeZone: string; generatedAt: string }) {
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
