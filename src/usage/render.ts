import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	UsageRequestError,
	type ProviderUsage,
	type UsageProviderError,
	type UsageResetCredit,
	type UsageResetCredits,
	type UsageSnapshot,
	type UsageWindow,
} from "./types.js";

const WIDE_MIN_WIDTH = 80;
const BAR_WIDTH = 20;
const TIME_WIDTH = 19;
const INDEX_WIDTH = 3;
const STATE_WIDTH = 12;
const TABLE_GAP = "   ";
const MAX_DISPLAY_TEXT = 240;

/** 用剩余额度进度条和响应式重置卡列表渲染所有 OAuth plan。 */
export function renderUsage(snapshot: UsageSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [
		`Plan Usage · Queried ${formatDateTime(snapshot.generatedAt, snapshot.timeZone)}`,
		`Timezone: ${snapshot.timeZone}`,
		"",
	];
	const providers = snapshot.providers.filter((provider) => provider.status !== "not_logged_in");
	if (providers.length === 0) {
		lines.push("No logged-in supported plan providers.");
	} else {
		for (const [index, provider] of providers.entries()) {
			if (index > 0) lines.push("");
			lines.push(...renderProvider(provider, snapshot, safeWidth));
		}
	}
	lines.push("", "Esc / Enter / q to close");
	return lines.flatMap((line) => wrapLine(line, safeWidth));
}

/** 顶层失败不显示底层异常文本、响应正文或凭据。 */
export function renderUsageError(error: unknown, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const message = error instanceof UsageRequestError && error.code === "aborted"
		? "The usage request was cancelled."
		: "Plan usage could not be loaded. Please try again.";
	return ["Plan Usage · Request failed", "", message, "", "Esc / Enter / q to close"].flatMap((line) => wrapLine(line, safeWidth));
}

function renderProvider(provider: ProviderUsage, snapshot: UsageSnapshot, width: number): string[] {
	const name = cleanDisplayText(provider.name);
	if (provider.status === "not_logged_in") {
		return [`${name} · OAuth not logged in`, `Run /login ${provider.loginProvider} to connect this plan.`];
	}
	if (provider.status === "error") {
		return [`${name} · Request failed`, formatProviderError(provider.error)];
	}

	const lines = [`${name} · ${provider.plan === undefined ? "plan unknown" : cleanDisplayText(provider.plan)}`];
	if (provider.windows.length === 0) lines.push("Usage window information unavailable.");
	else lines.push(...provider.windows.map((window) => renderWindow(window, snapshot)));
	for (const detail of provider.details) {
		lines.push(`${cleanDisplayText(detail.label)}: ${cleanDisplayText(detail.value)}`);
	}
	if (provider.resetCredits !== undefined) lines.push("", ...renderResetCredits(provider.resetCredits, snapshot, width));
	return lines;
}

function renderResetCredits(resetCredits: UsageResetCredits, snapshot: UsageSnapshot, width: number): string[] {
	const lines = [`Codex Reset Credits · ${resetCredits.availableCount} available`];
	if (resetCredits.credits === undefined) return lines.concat("Reset-credit details unavailable.");
	if (resetCredits.credits.length === 0) return lines.concat("No reset credits reported.");
	return lines.concat(width >= WIDE_MIN_WIDTH
		? renderWideResetCredits(resetCredits.credits, snapshot, width)
		: renderCompactResetCredits(resetCredits.credits, snapshot));
}

function renderWideResetCredits(credits: UsageResetCredit[], snapshot: UsageSnapshot, width: number): string[] {
	const fixedWidth = INDEX_WIDTH + STATE_WIDTH + TIME_WIDTH + TIME_WIDTH + visibleWidth(TABLE_GAP) * 4;
	const detailsWidth = Math.max(visibleWidth("Details"), width - fixedWidth);
	const lines = [
		[padEnd("#", INDEX_WIDTH), padEnd("Status", STATE_WIDTH), padEnd("Granted", TIME_WIDTH), padEnd("Expires", TIME_WIDTH), "Details"].join(TABLE_GAP),
		["-".repeat(INDEX_WIDTH), "-".repeat(STATE_WIDTH), "-".repeat(TIME_WIDTH), "-".repeat(TIME_WIDTH), "-".repeat(detailsWidth)].join(TABLE_GAP),
	];
	for (const [index, credit] of credits.entries()) {
		lines.push([
			padEnd(String(index + 1), INDEX_WIDTH),
			padEnd(cleanDisplayText(credit.status), STATE_WIDTH),
			padEnd(formatDateTime(credit.grantedAt, snapshot.timeZone), TIME_WIDTH),
			padEnd(formatDateTime(credit.expiresAt, snapshot.timeZone), TIME_WIDTH),
			formatResetCreditDetails(credit, snapshot.generatedAt),
		].join(TABLE_GAP));
	}
	return lines;
}

function renderCompactResetCredits(credits: UsageResetCredit[], snapshot: UsageSnapshot): string[] {
	const lines: string[] = [];
	for (const [index, credit] of credits.entries()) {
		if (lines.length > 0) lines.push("");
		lines.push(`#${index + 1} ${cleanDisplayText(credit.status)} · ${formatResetCreditDetails(credit, snapshot.generatedAt)}`);
		lines.push(`Granted ${formatDateTime(credit.grantedAt, snapshot.timeZone)}`);
		lines.push(`Expires ${formatDateTime(credit.expiresAt, snapshot.timeZone)}`);
	}
	return lines;
}

function formatResetCreditDetails(credit: UsageResetCredit, now: Date): string {
	const details = [...new Set([credit.title, credit.description, credit.resetType].filter((value): value is string => value !== undefined))];
	return `${details.map(cleanDisplayText).join(" · ")} · expires ${formatExpiryDistance(credit.expiresAt, now)}`;
}

function renderWindow(window: UsageWindow, snapshot: UsageSnapshot): string {
	const used = window.usedPercent === undefined ? undefined : clampPercent(window.usedPercent);
	const remaining = used === undefined ? undefined : clampPercent(100 - used);
	const bar = renderProgress(remaining);
	const duration = window.windowDurationMins === undefined ? "window unknown" : formatWindowDuration(window.windowDurationMins);
	const reset = window.resetsAt === undefined
		? "unknown"
		: `${formatDateTime(window.resetsAt, snapshot.timeZone)} (${formatUntil(window.resetsAt, snapshot.generatedAt)})`;
	if (used === undefined || remaining === undefined) {
		return `${cleanDisplayText(window.label)} ${bar} usage unavailable · ${duration} · resets ${reset}`;
	}
	return `${cleanDisplayText(window.label)} ${bar} ${formatPercent(remaining)}% remaining · ${formatPercent(used)}% used · ${duration} · resets ${reset}`;
}

function renderProgress(percent: number | undefined): string {
	if (percent === undefined) return `[${"-".repeat(BAR_WIDTH)}]`;
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}]`;
}

function formatProviderError(error: UsageProviderError): string {
	if (error.code === "auth") return "Could not resolve Pi OAuth credentials. Run /login again.";
	if (error.code === "timeout") return "The provider usage request timed out.";
	if (error.code === "http") return error.httpStatus === undefined ? "The provider rejected the usage request." : `The provider returned HTTP ${error.httpStatus}.`;
	if (error.code === "response_too_large") return "The provider returned an oversized usage response.";
	if (error.code === "invalid_response") return "The provider returned an unexpected usage response.";
	return "The provider usage request failed.";
}

function formatDateTime(date: Date | undefined, timeZone: string): string {
	if (date === undefined) return "unknown";
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(date).replace(", ", " ");
}

function formatExpiryDistance(date: Date | undefined, now: Date): string {
	if (date === undefined) return "never";
	const delta = date.getTime() - now.getTime();
	const duration = formatDuration(Math.abs(delta));
	return delta >= 0 ? `in ${duration}` : `${duration} ago`;
}

function formatDuration(milliseconds: number): string {
	const minutes = Math.floor(milliseconds / 60_000);
	if (minutes < 1) return "<1m";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

function formatUntil(date: Date, now: Date): string {
	const minutes = Math.max(0, Math.floor((date.getTime() - now.getTime()) / 60_000));
	if (minutes < 1) return "now";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
	if (hours > 0) return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
	return `in ${mins}m`;
}

function formatWindowDuration(minutes: number): string {
	if (minutes < 60) return `${formatNumber(minutes)}m window`;
	if (minutes % 1440 === 0) return `${formatNumber(minutes / 1440)}d window`;
	if (minutes % 60 === 0) return `${formatNumber(minutes / 60)}h window`;
	return `${formatNumber(minutes)}m window`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function cleanDisplayText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
		.trim()
		.slice(0, MAX_DISPLAY_TEXT);
}

function wrapLine(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
