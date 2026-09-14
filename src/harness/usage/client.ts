import type { AuthResult } from "@earendil-works/pi-ai";
import {
	UsageRequestError,
	type ProviderUsage,
	type UsageDetail,
	type UsageProviderError,
	type UsageProviderId,
	type UsageResetCredit,
	type UsageResetCredits,
	type UsageSnapshot,
	type UsageWindow,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_OPTIONAL_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 1_048_576;
const FIVE_HOURS_MINS = 5 * 60;
const SEVEN_DAYS_MINS = 7 * 24 * 60;
const MAX_PROVIDER_ITEMS = 10;
const MAX_RESET_CREDITS = 50;
const MAX_LABEL_LENGTH = 80;
const MAX_DETAIL_LENGTH = 200;

export interface UsageContext {
	modelRegistry: {
		getProviderAuth(provider: string): Promise<AuthResult | undefined>;
	};
}

export interface UsageClientOptions {
	fetchImpl: typeof fetch;
	signal: AbortSignal | undefined;
	now: Date;
}

interface ProviderUsageData {
	plan: string | undefined;
	windows: UsageWindow[];
	details: UsageDetail[];
	resetCredits: UsageResetCredits | undefined;
}

interface ProviderDefinition {
	id: UsageProviderId;
	name: string;
	fetchUsage(token: string, options: UsageClientOptions): Promise<ProviderUsageData>;
}

interface JsonRequestOptions {
	fetchImpl: typeof fetch;
	parentSignal: AbortSignal | undefined;
	timeoutMs: number;
	headers: Record<string, string>;
}

class UsageHttpError extends Error {
	constructor(readonly status: number) {
		super(`http_${status}`);
		this.name = "UsageHttpError";
	}
}

const PROVIDERS: readonly ProviderDefinition[] = [
	{ id: "anthropic", name: "Claude", fetchUsage: fetchAnthropicUsage },
	{ id: "openai-codex", name: "Codex", fetchUsage: fetchCodexUsage },
	{ id: "kimi-coding", name: "Kimi", fetchUsage: fetchKimiUsage },
	{ id: "xai", name: "Grok", fetchUsage: fetchXaiUsage },
];

/** 并发读取 Pi 官方 OAuth plan 的额度。单个 provider 失败不会遮蔽其他结果。 */
export async function collectUsageSnapshot(context: UsageContext, options: UsageClientOptions): Promise<UsageSnapshot> {
	const providers = await Promise.all(PROVIDERS.map((provider) => collectProviderUsage(provider, context, options)));
	return {
		generatedAt: options.now.toISOString(),
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		providers,
	};
}

async function collectProviderUsage(
	provider: ProviderDefinition,
	context: UsageContext,
	options: UsageClientOptions,
): Promise<ProviderUsage> {
	let token: string | undefined;
	try {
		token = await getOAuthToken(context, provider.id);
	} catch {
		return providerError(provider, { code: "auth" });
	}
	if (token === undefined) return { id: provider.id, name: provider.name, status: "not_logged_in" };

	try {
		const usage = await provider.fetchUsage(token, options);
		return { id: provider.id, name: provider.name, status: "ok", ...usage };
	} catch (error) {
		if (error instanceof UsageRequestError && error.code === "aborted") throw error;
		return providerError(provider, toProviderError(error));
	}
}

async function getOAuthToken(context: UsageContext, provider: UsageProviderId): Promise<string | undefined> {
	const result = await context.modelRegistry.getProviderAuth(provider);
	if (result?.source !== "OAuth") return undefined;
	const token = provider === "kimi-coding" ? kimiBearerToken(result) : result.auth.apiKey;
	if (typeof token !== "string" || token.length === 0) throw new Error(`Missing OAuth token for ${provider}`);
	return token;
}

function kimiBearerToken(result: AuthResult): string | undefined {
	const authorization = result.auth.headers?.Authorization;
	return typeof authorization === "string" && authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: undefined;
}

async function fetchAnthropicUsage(token: string, options: UsageClientOptions): Promise<ProviderUsageData> {
	const usage = requireRecord(await getJson(
		"https://api.anthropic.com/api/oauth/usage",
		token,
		requestOptions(options, DEFAULT_TIMEOUT_MS),
	));
	const windows: UsageWindow[] = [];
	pushAnthropicWindow(windows, "Session (5h)", usage.five_hour, FIVE_HOURS_MINS);
	pushAnthropicWindow(windows, "Week (all models)", usage.seven_day, SEVEN_DAYS_MINS);

	for (const value of optionalArray(usage.limits).slice(0, MAX_PROVIDER_ITEMS)) {
		const limit = requireRecord(value);
		if (limit.kind !== "weekly_scoped") continue;
		const scope = optionalRecord(limit.scope);
		const model = optionalRecord(scope?.model);
		const modelName = displayString(model?.display_name, MAX_LABEL_LENGTH);
		if (modelName === undefined) continue;
		windows.push({
			label: `Week (${modelName})`,
			usedPercent: requiredPercent(limit.percent),
			windowDurationMins: SEVEN_DAYS_MINS,
			resetsAt: toIsoString(optionalDate(limit.resets_at)),
		});
	}

	return {
		plan: undefined,
		windows,
		details: anthropicDetails(usage),
		resetCredits: undefined,
	};
}

function pushAnthropicWindow(windows: UsageWindow[], label: string, value: unknown, durationMins: number): void {
	const window = optionalRecord(value);
	if (window === undefined) return;
	windows.push({
		label,
		usedPercent: optionalPercent(window.utilization),
		windowDurationMins: durationMins,
		resetsAt: toIsoString(optionalDate(window.resets_at)),
	});
}

function anthropicDetails(usage: Record<string, unknown>): UsageDetail[] {
	const extra = optionalRecord(usage.extra_usage);
	if (extra === undefined) return [];
	if (typeof extra.is_enabled !== "boolean") invalidResponse();
	const used = optionalNumber(extra.used_credits);
	const limit = optionalNumber(extra.monthly_limit);
	if (used === undefined || limit === undefined) return [];
	const currency = displayString(extra.currency, 12);
	const amount = `${currency === undefined ? "" : `${currency} `}${formatNumber(used)} / ${formatNumber(limit)}`;
	return [{ label: "Extra usage", value: extra.is_enabled ? amount : `disabled (${amount} spent)` }];
}

async function fetchCodexUsage(token: string, options: UsageClientOptions): Promise<ProviderUsageData> {
	const accountId = codexAccountId(token);
	const headers = { "ChatGPT-Account-Id": accountId };
	const [usageValue, resetValue] = await Promise.all([
		getJson("https://chatgpt.com/backend-api/wham/usage", token, requestOptions(options, DEFAULT_TIMEOUT_MS, headers)),
		getOptionalJson(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
			token,
			requestOptions(options, DEFAULT_OPTIONAL_TIMEOUT_MS, headers),
		),
	]);
	const usage = requireRecord(usageValue);
	const windows: UsageWindow[] = [];
	pushCodexRateLimitWindows(windows, optionalRecord(usage.rate_limit), "Plan quota");
	for (const value of optionalArray(usage.additional_rate_limits).slice(0, MAX_PROVIDER_ITEMS)) {
		const entry = requireRecord(value);
		const limitName = requireDisplayString(entry.limit_name, MAX_LABEL_LENGTH);
		pushCodexRateLimitWindows(windows, optionalRecord(entry.rate_limit), `${limitName} quota`);
	}

	const details: UsageDetail[] = [];
	const credits = optionalRecord(usage.credits);
	if (credits !== undefined) {
		if (typeof credits.unlimited !== "boolean" || typeof credits.has_credits !== "boolean") invalidResponse();
		const balance = credits.unlimited ? "unlimited" : displayString(credits.balance, MAX_DETAIL_LENGTH);
		const availability = credits.has_credits ? "available" : "unavailable";
		const value = [balance, availability].filter((part): part is string => part !== undefined).join(" · ");
		details.push({ label: "Account credits", value });
	}
	const summary = optionalRecord(usage.rate_limit_reset_credits);
	const summaryCount = summary === undefined ? undefined : requiredCount(summary.available_count);

	return {
		plan: requireDisplayString(usage.plan_type, MAX_LABEL_LENGTH),
		windows,
		details,
		resetCredits: parseResetCredits(resetValue, summaryCount),
	};
}

function pushCodexRateLimitWindows(
	windows: UsageWindow[],
	rateLimit: Record<string, unknown> | undefined,
	sectionLabel: string,
): void {
	for (const value of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
		const window = optionalRecord(value);
		if (window === undefined) continue;
		const durationSeconds = requiredPositiveNumber(window.limit_window_seconds);
		const durationMins = durationSeconds / 60;
		windows.push({
			label: windowLabel(durationMins),
			sectionLabel,
			usedPercent: requiredPercent(window.used_percent),
			windowDurationMins: durationMins,
			resetsAt: requiredUnixSecondsDate(window.reset_at).toISOString(),
		});
	}
}

function parseResetCredits(value: unknown | undefined, fallbackCount: number | undefined): UsageResetCredits | undefined {
	const payload = recordValue(value);
	const endpointCount = safeCount(payload?.available_count);
	const availableCount = endpointCount ?? fallbackCount;
	if (availableCount === undefined) return undefined;
	if (!Array.isArray(payload?.credits)) return { availableCount, credits: undefined };
	const credits: UsageResetCredit[] = [];
	for (const rawCredit of payload.credits.slice(0, MAX_RESET_CREDITS)) {
		const credit = parseResetCredit(rawCredit);
		if (credit !== undefined) credits.push(credit);
	}
	return { availableCount, credits };
}

function parseResetCredit(value: unknown): UsageResetCredit | undefined {
	const credit = recordValue(value);
	const status = displayString(credit?.status, MAX_LABEL_LENGTH);
	const grantedAt = safeDateString(credit?.granted_at);
	if (credit === undefined || status === undefined || grantedAt === undefined) return undefined;
	return {
		status,
		grantedAt,
		expiresAt: credit.expires_at === null ? undefined : safeDateString(credit.expires_at),
	};
}

async function fetchKimiUsage(token: string, options: UsageClientOptions): Promise<ProviderUsageData> {
	const usage = requireRecord(await getJson(
		"https://api.kimi.com/coding/v1/usages",
		token,
		requestOptions(options, DEFAULT_TIMEOUT_MS),
	));
	const windows: UsageWindow[] = [];
	for (const value of optionalArray(usage.limits).slice(0, MAX_PROVIDER_ITEMS)) {
		const limit = requireRecord(value);
		const window = optionalRecord(limit.window);
		if (window?.timeUnit !== "TIME_UNIT_MINUTE") continue;
		const detail = requireRecord(limit.detail);
		const duration = requiredPositiveNumber(window.duration);
		windows.push({
			label: windowLabel(duration),
			usedPercent: decimalRatioPercent(detail.used, detail.limit),
			windowDurationMins: duration,
			resetsAt: toIsoString(optionalDate(detail.resetTime)),
		});
		break;
	}
	const weekly = optionalRecord(usage.usage);
	if (weekly !== undefined) {
		windows.push({
			label: "Week",
			usedPercent: decimalRatioPercent(weekly.used, weekly.limit),
			windowDurationMins: SEVEN_DAYS_MINS,
			resetsAt: toIsoString(optionalDate(weekly.resetTime)),
		});
	}
	return { plan: undefined, windows, details: [], resetCredits: undefined };
}

async function fetchXaiUsage(token: string, options: UsageClientOptions): Promise<ProviderUsageData> {
	const headers = { "X-XAI-Token-Auth": "xai-grok-cli" };
	const [creditsValue, settingsValue] = await Promise.all([
		getJson(
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			token,
			requestOptions(options, DEFAULT_TIMEOUT_MS, headers),
		),
		getOptionalJson(
			"https://cli-chat-proxy.grok.com/v1/settings",
			token,
			requestOptions(options, DEFAULT_OPTIONAL_TIMEOUT_MS, headers),
		),
	]);
	const payload = requireRecord(creditsValue);
	const config = optionalRecord(payload.config);
	const windows: UsageWindow[] = [];
	const details: UsageDetail[] = [];

	if (config !== undefined) {
		const period = optionalRecord(config.currentPeriod);
		const periodType = period?.type;
		const periodStart = optionalDate(period?.start);
		const periodEnd = optionalDate(period?.end);
		const usedPercent = optionalPercent(config.creditUsagePercent);
		if (period !== undefined || usedPercent !== undefined) {
			windows.push({
				label: xaiPeriodLabel(periodType),
				usedPercent,
				windowDurationMins: durationMinutes(periodStart, periodEnd),
				resetsAt: toIsoString(periodEnd),
			});
		}

		const monthlyUsed = optionalNumber(optionalRecord(config.used)?.val);
		const monthlyLimit = optionalNumber(optionalRecord(config.monthlyLimit)?.val);
		const monthlyStart = optionalDate(config.billingPeriodStart);
		const monthlyEnd = optionalDate(config.billingPeriodEnd);
		if (periodType !== "USAGE_PERIOD_TYPE_MONTHLY" && monthlyLimit !== undefined && monthlyLimit > 0) {
			windows.push({
				label: "Month (included allowance)",
				usedPercent: ratioPercent(monthlyUsed, monthlyLimit),
				windowDurationMins: durationMinutes(monthlyStart, monthlyEnd),
				resetsAt: toIsoString(monthlyEnd),
			});
		}
		if (monthlyUsed !== undefined) {
			const absolute = monthlyLimit !== undefined && monthlyLimit > 0
				? `${formatNumber(monthlyUsed)} / ${formatNumber(monthlyLimit)} used`
				: `${formatNumber(monthlyUsed)} used; no limit reported`;
			details.push({ label: "Monthly included credits", value: absolute });
		}
	}

	const settings = recordValue(settingsValue);
	return {
		plan: displayString(settings?.subscription_tier_display, MAX_LABEL_LENGTH),
		windows,
		details,
		resetCredits: undefined,
	};
}

function xaiPeriodLabel(value: unknown): string {
	if (value === undefined || value === null) return "Included allowance";
	if (value === "USAGE_PERIOD_TYPE_WEEKLY") return "Week (included allowance)";
	if (value === "USAGE_PERIOD_TYPE_MONTHLY") return "Month (included allowance)";
	return invalidResponse();
}

function durationMinutes(start: Date | undefined, end: Date | undefined): number | undefined {
	if (start === undefined || end === undefined) return undefined;
	const duration = (end.getTime() - start.getTime()) / 60_000;
	if (duration < 0) invalidResponse();
	return duration;
}

function requestOptions(
	options: UsageClientOptions,
	timeoutMs: number,
	headers: Record<string, string> = {},
): JsonRequestOptions {
	return { fetchImpl: options.fetchImpl, parentSignal: options.signal, timeoutMs, headers };
}

async function getOptionalJson(url: string, token: string, options: JsonRequestOptions): Promise<unknown | undefined> {
	try {
		return await getJson(url, token, options);
	} catch (error) {
		if (error instanceof UsageRequestError) {
			if (error.code === "aborted") throw error;
			return undefined;
		}
		if (error instanceof UsageHttpError) return undefined;
		throw error;
	}
}

async function getJson(url: string, token: string, options: JsonRequestOptions): Promise<unknown> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.parentSignal === undefined
		? timeoutSignal
		: AbortSignal.any([options.parentSignal, timeoutSignal]);
	let response: Response;
	try {
		response = await options.fetchImpl(url, {
			signal,
			headers: { ...options.headers, Authorization: `Bearer ${token}`, Accept: "application/json" },
			redirect: "error",
		});
	} catch {
		throw requestFailure(options.parentSignal, timeoutSignal);
	}
	if (response.status < 200 || response.status >= 300) {
		await response.body?.cancel().catch(() => undefined);
		throw new UsageHttpError(response.status);
	}
	let text: string;
	try {
		text = await readBody(response, MAX_RESPONSE_BYTES);
	} catch (error) {
		if (error instanceof UsageRequestError) throw error;
		throw requestFailure(options.parentSignal, timeoutSignal);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new UsageRequestError("invalid_response");
	}
}

function requestFailure(parentSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): UsageRequestError {
	if (parentSignal?.aborted) return new UsageRequestError("aborted");
	if (timeoutSignal.aborted) return new UsageRequestError("timeout");
	return new UsageRequestError("request_failed");
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new UsageRequestError("response_too_large");
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

function providerError(provider: ProviderDefinition, error: UsageProviderError): ProviderUsage {
	return { id: provider.id, name: provider.name, status: "error", error };
}

function toProviderError(error: unknown): UsageProviderError {
	if (error instanceof UsageHttpError) return { code: "http", httpStatus: error.status };
	if (!(error instanceof UsageRequestError)) return { code: "request_failed" };
	if (error.code === "timeout") return { code: "timeout" };
	if (error.code === "response_too_large") return { code: "response_too_large" };
	if (error.code === "invalid_response") return { code: "invalid_response" };
	return { code: "request_failed" };
}

function codexAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Invalid Codex OAuth token");
	const [, payloadPart] = parts as [string, string, string];
	const payload = requireRecord(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown);
	const auth = requireRecord(payload["https://api.openai.com/auth"]);
	const accountId = auth.chatgpt_account_id;
	if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(accountId)) {
		throw new Error("Invalid Codex account ID");
	}
	return accountId;
}

function windowLabel(durationMins: number): string {
	if (durationMins === SEVEN_DAYS_MINS) return "Week";
	if (durationMins % 1440 === 0) return `Session (${durationMins / 1440}d)`;
	if (durationMins % 60 === 0) return `Session (${durationMins / 60}h)`;
	return `Session (${formatNumber(durationMins)}m)`;
}

function requireRecord(value: unknown): Record<string, unknown> {
	const record = recordValue(value);
	if (record === undefined) invalidResponse();
	return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	return requireRecord(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function optionalArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) invalidResponse();
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) invalidResponse();
	return value;
}

function requiredPositiveNumber(value: unknown): number {
	const number = optionalNumber(value);
	if (number === undefined || number <= 0) invalidResponse();
	return number;
}

function optionalPercent(value: unknown): number | undefined {
	const number = optionalNumber(value);
	return number === undefined ? undefined : clampPercent(number);
}

function requiredPercent(value: unknown): number {
	const percent = optionalPercent(value);
	if (percent === undefined) invalidResponse();
	return percent;
}

function decimalRatioPercent(usedValue: unknown, limitValue: unknown): number | undefined {
	return ratioPercent(decimalNumber(usedValue), decimalNumber(limitValue));
}

function decimalNumber(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const number = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() !== ""
			? Number(value)
			: Number.NaN;
	if (!Number.isFinite(number)) invalidResponse();
	return number;
}

function ratioPercent(used: number | undefined, limit: number | undefined): number | undefined {
	return used === undefined || limit === undefined || limit <= 0
		? undefined
		: clampPercent((used / limit) * 100);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function safeCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function requiredCount(value: unknown): number {
	const count = safeCount(value);
	if (count === undefined) invalidResponse();
	return count;
}

function optionalDate(value: unknown): Date | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") invalidResponse();
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) invalidResponse();
	return new Date(milliseconds);
}

function requiredUnixSecondsDate(value: unknown): Date {
	if (typeof value !== "number" || !Number.isFinite(value)) invalidResponse();
	const date = new Date(value * 1_000);
	if (!Number.isFinite(date.getTime())) invalidResponse();
	return date;
}

function safeDateString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function toIsoString(value: Date | undefined): string | undefined {
	return value?.toISOString();
}

function requireDisplayString(value: unknown, maxLength: number): string {
	const text = displayString(value, maxLength);
	if (text === undefined) invalidResponse();
	return text;
}

function displayString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
		.trim()
		.slice(0, maxLength);
	return clean === "" ? undefined : clean;
}

function invalidResponse(): never {
	throw new UsageRequestError("invalid_response");
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
