import type { ReactNode } from "react";

export const number = (value: number | undefined) => value === undefined ? "暂无数据" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
export const percent = (value: number | undefined | null) => value == null ? "暂无数据" : `${number(value)}%`;
export const money = (value: number | undefined) => value === undefined ? "暂无数据" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
export const duration = (ms: number | undefined) => ms === undefined ? "暂无数据" : ms < 1000 ? `${number(ms)} ms` : `${number(ms / 1000)} s`;
export const dateTime = (value: string, timeZone?: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
export type Tone = "accent" | "success" | "warning" | "danger";

export function Metrics({ items }: { items: { label: string; value: ReactNode; hint?: string; tone?: Tone }[] }) {
	return <dl className="report-metrics">{items.map((item) => <div className="report-metric" key={item.label} data-tone={item.tone}>
		<dt>{item.label}</dt><dd>{item.value}</dd>{item.hint && <small>{item.hint}</small>}
	</div>)}</dl>;
}

export function Section({ title, children, detail = false }: { title: string; children: ReactNode; detail?: boolean }) {
	return detail ? <details className="report-section"><summary>{title}</summary><div className="report-section-body">{children}</div></details>
		: <section className="report-section" aria-label={title}><h3>{title}</h3><div className="report-section-body">{children}</div></section>;
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
	return <dl className="report-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function Bar({ label, value, text, hint, tone = "accent" }: { label: string; value: number | undefined | null; text?: string; hint?: string; tone?: Tone }) {
	return <div className="report-bar" data-tone={tone}>
		<div className="report-bar-label"><span>{label}</span><strong>{text ?? percent(value)}</strong></div>
		{value != null && <meter min={0} max={100} value={Math.min(100, Math.max(0, value))} aria-label={label} aria-valuetext={text ?? percent(value)} />}
		{hint && <small>{hint}</small>}
	</div>;
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="report-empty">{children}</p>;
}

export function ReportStamp({ at, timeZone }: { at: string; timeZone?: string }) {
	return <p className="report-stamp">快照时间 <time dateTime={at}>{dateTime(at, timeZone)}</time>{timeZone && ` · ${timeZone}`}</p>;
}
