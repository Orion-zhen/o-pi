import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CodexQuotaError, type CodexQuotaBucket, type CodexQuotaSnapshot, type CodexQuotaWindow, type CodexResetCredit } from "./types.js";

const WIDE_MIN_WIDTH = 80;
const BAR_WIDTH = 20;
const TIME_WIDTH = 19;
const INDEX_WIDTH = 3;
const STATE_WIDTH = 12;
const TABLE_GAP = "   ";

/** Render quota windows and reset-credit details for both TUI and non-TUI output. */
export function renderCodexQuota(snapshot: CodexQuotaSnapshot, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [
		`Codex Quota · ${formatPlan(snapshot.buckets)} · Queried ${formatDateTime(snapshot.generatedAt, snapshot.timeZone)}`,
		`Timezone: ${snapshot.timeZone}`,
		"",
		...(snapshot.buckets.length === 0 ? ["No quota information available."] : snapshot.buckets.flatMap((bucket) => renderBucket(bucket, snapshot, safeWidth))),
		"",
		...renderResetCredits(snapshot, safeWidth),
		"",
		"Esc / Enter / q to close",
	];
	return lines.flatMap((line) => wrapLine(line, safeWidth));
}

/** Render a sanitized app-server error without stderr or protocol payloads. */
export function renderCodexQuotaError(error: unknown, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return ["Codex Quota · Request failed", "", getErrorMessage(error), "", "Esc / Enter / q to close"].flatMap((line) => wrapLine(line, safeWidth));
}

function renderBucket(bucket: CodexQuotaBucket, snapshot: CodexQuotaSnapshot, width: number): string[] {
	const label = bucket.name ? `${bucket.id} · ${bucket.name}` : bucket.id;
	const lines = [`Quota bucket · ${label}`];
	if (bucket.primary) lines.push(renderWindow("Primary", bucket.primary, snapshot));
	if (bucket.secondary) lines.push(renderWindow("Secondary", bucket.secondary, snapshot));
	if (!bucket.primary && !bucket.secondary) lines.push("Window information unavailable.");
	if (bucket.credits) {
		const balance = bucket.credits.unlimited ? "unlimited" : bucket.credits.balance ?? "unknown";
		lines.push(`Account credits: ${balance} · ${bucket.credits.hasCredits ? "available" : "unavailable"}`);
	}
	return lines.concat(width >= WIDE_MIN_WIDTH ? [""] : []);
}

function renderWindow(label: string, window: CodexQuotaWindow, snapshot: CodexQuotaSnapshot): string {
	const remaining = window.usedPercent === undefined ? undefined : clampPercent(100 - window.usedPercent);
	const used = window.usedPercent === undefined ? undefined : clampPercent(window.usedPercent);
	const bar = renderProgress(remaining);
	const remainingText = remaining === undefined ? "unknown" : `${formatPercent(remaining)}% remaining`;
	const usedText = used === undefined ? "unknown" : `${formatPercent(used)}% used`;
	const duration = window.windowDurationMins === undefined ? "window unknown" : formatWindowDuration(window.windowDurationMins);
	const reset = window.resetsAt ? `${formatDateTime(window.resetsAt, snapshot.timeZone)} (${formatUntil(window.resetsAt, snapshot.generatedAt)})` : "unknown";
	return `${label} ${bar} ${remainingText} · ${usedText} · ${duration} · resets ${reset}`;
}

function renderProgress(percent: number | undefined): string {
	if (percent === undefined) return `[${"-".repeat(BAR_WIDTH)}] unknown`;
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}]`;
}

function renderResetCredits(snapshot: CodexQuotaSnapshot, width: number): string[] {
	const resetCredits = snapshot.resetCredits;
	if (!resetCredits) return ["Codex Reset Credits", "app-server returned no reset-credit information."];
	const lines = [`Codex Reset Credits · ${resetCredits.availableCount} available`];
	if (resetCredits.credits === undefined) return lines.concat("Reset-credit details unavailable.");
	if (resetCredits.credits.length === 0) return lines.concat("No available reset credits.");
	return lines.concat(width >= WIDE_MIN_WIDTH ? renderWideCredits(resetCredits.credits, snapshot, width) : renderCompactCredits(resetCredits.credits, snapshot, width));
}

function renderWideCredits(credits: CodexResetCredit[], snapshot: CodexQuotaSnapshot, width: number): string[] {
	const fixedWidth = INDEX_WIDTH + STATE_WIDTH + TIME_WIDTH + TIME_WIDTH + visibleWidth(TABLE_GAP) * 4;
	const detailsWidth = Math.max(visibleWidth("Details"), width - fixedWidth);
	const lines = [
		[padEnd("#", INDEX_WIDTH), padEnd("Status", STATE_WIDTH), padEnd("Granted", TIME_WIDTH), padEnd("Expires", TIME_WIDTH), "Details"].join(TABLE_GAP),
		["-".repeat(INDEX_WIDTH), "-".repeat(STATE_WIDTH), "-".repeat(TIME_WIDTH), "-".repeat(TIME_WIDTH), "-".repeat(detailsWidth)].join(TABLE_GAP),
	];
	for (const [index, credit] of credits.entries()) {
		lines.push(
			[padEnd(String(index + 1), INDEX_WIDTH), padEnd(credit.status, STATE_WIDTH), padEnd(formatDateTime(credit.grantedAt, snapshot.timeZone), TIME_WIDTH), padEnd(formatDateTime(credit.expiresAt, snapshot.timeZone), TIME_WIDTH), `Expires ${formatExpiryDistance(credit.expiresAt, snapshot.generatedAt)}`].join(TABLE_GAP),
		);
	}
	return lines;
}

function renderCompactCredits(credits: CodexResetCredit[], snapshot: CodexQuotaSnapshot, _width: number): string[] {
	const lines: string[] = [];
	for (const [index, credit] of credits.entries()) {
		if (lines.length > 0) lines.push("");
		lines.push(`#${index + 1} ${credit.status} · Expires ${formatExpiryDistance(credit.expiresAt, snapshot.generatedAt)}`);
		lines.push(`Granted ${formatDateTime(credit.grantedAt, snapshot.timeZone)}`);
		lines.push(`Expires ${formatDateTime(credit.expiresAt, snapshot.timeZone)}`);
	}
	return lines;
}

function formatPlan(buckets: CodexQuotaBucket[]): string {
	const plans = [...new Set(buckets.map((bucket) => bucket.planType).filter((plan): plan is string => plan !== undefined))];
	return plans.length === 0 ? "plan unknown" : plans.join(", ");
}

function formatDateTime(date: Date | undefined, timeZone: string): string {
	if (!date) return "unknown";
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

function formatExpiryDistance(date: Date | undefined, now: Date): string {
	if (!date) return "No expiry";
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

function formatWindowDuration(minutes: number): string {
	if (minutes < 60) return `${minutes}m window`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d window`;
	if (minutes % 60 === 0) return `${minutes / 60}h window`;
	return `${minutes}m window`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getErrorMessage(error: unknown): string {
	if (!(error instanceof CodexQuotaError)) return "Request failed. Please try again.";
	if (error.code === "command_not_found") return "The codex command was not found.";
	if (error.code === "startup_failed") return "Could not start codex app-server.";
	if (error.code === "timeout") return "The codex app-server request timed out.";
	if (error.code === "aborted") return "The quota request was cancelled.";
	if (error.code === "server_error") return "Codex app-server rejected the quota request.";
	if (error.code === "unexpected_response") return "Codex app-server returned an unexpected quota response.";
	if (error.code === "protocol_error") return "Codex app-server returned invalid protocol data.";
	return "The codex app-server process failed. Check the Codex CLI.";
}

function wrapLine(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
