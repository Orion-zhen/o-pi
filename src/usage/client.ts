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

export interface UsageHttpResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	readonly body: {
		getReader(): {
			read(): Promise<{ done: boolean; value?: Uint8Array }>;
			cancel(): Promise<void>;
		};
		cancel(): Promise<void>;
	} | null;
}

export interface UsageHttpRequest {
	readonly signal: AbortSignal;
	readonly headers: Record<string, string>;
}

export type UsageFetch = (url: string, request: UsageHttpRequest) => Promise<UsageHttpResponse>;

export interface UsageClientOptions {
	fetchImpl?: UsageFetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	optionalTimeoutMs?: number;
	now?: Date;
}

interface ResolvedClientOptions {
	fetchImpl: UsageFetch;
	signal: AbortSignal | undefined;
	timeoutMs: number;
	optionalTimeoutMs: number;
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
	fetchUsage(token: string, options: ResolvedClientOptions): Promise<ProviderUsageData>;
}

interface JsonRequestOptions {
	fetchImpl: UsageFetch;
	parentSignal: AbortSignal | undefined;
	timeoutMs: number;
	headers: Record<string, string>;
}

const PROVIDERS: readonly ProviderDefinition[] = [
	{ id: "anthropic", name: "Claude", fetchUsage: fetchAnthropicUsage },
	{ id: "openai-codex", name: "Codex", fetchUsage: fetchCodexUsage },
	{ id: "kimi-coding", name: "Kimi", fetchUsage: fetchKimiUsage },
	{ id: "xai", name: "Grok", fetchUsage: fetchXaiUsage },
];

/** 并发读取 Pi 官方 OAuth plan 的额度；单个 provider 失败不会遮蔽其他结果。 */
export async function collectUsageSnapshot(context: UsageContext, options: UsageClientOptions = {}): Promise<UsageSnapshot> {
	const resolved: ResolvedClientOptions = {
		fetchImpl: options.fetchImpl ?? defaultFetch,
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		optionalTimeoutMs: options.optionalTimeoutMs ?? DEFAULT_OPTIONAL_TIMEOUT_MS,
		now: options.now ?? new Date(),
	};
	const providers = await Promise.all(PROVIDERS.map((provider) => collectProviderUsage(provider, context, resolved)));
	return {
		generatedAt: resolved.now,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		providers,
	};
}

async function collectProviderUsage(
	provider: ProviderDefinition,
	context: UsageContext,
	options: ResolvedClientOptions,
): Promise<ProviderUsage> {
	let token: string | undefined;
	try {
		token = await getOAuthToken(context, provider.id);
	} catch {
		return providerError(provider, { code: "auth", httpStatus: undefined });
	}
	if (token === undefined) {
		return { id: provider.id, name: provider.name, status: "not_logged_in", loginProvider: provider.id };
	}

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
	if (typeof result.auth.apiKey === "string" && result.auth.apiKey.length > 0) return result.auth.apiKey;
	for (const [name, value] of Object.entries(result.auth.headers ?? {})) {
		if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
		const match = /^Bearer\s+(.+)$/iu.exec(value);
		if (match?.[1]) return match[1].trim() || undefined;
	}
	return undefined;
}

async function fetchAnthropicUsage(token: string, options: ResolvedClientOptions): Promise<ProviderUsageData> {
	const headers = { "anthropic-beta": "oauth-2025-04-20" };
	const [usageValue, profileValue] = await Promise.all([
		getJson("https://api.anthropic.com/api/oauth/usage", token, requestOptions(options, options.timeoutMs, headers)),
		getOptionalJson("https://api.anthropic.com/api/oauth/profile", token, requestOptions(options, options.optionalTimeoutMs, headers)),
	]);
	const usage = requireRecord(usageValue);
	const windows: UsageWindow[] = [];
	pushWindow(windows, "Session (5h)", usage.five_hour, FIVE_HOURS_MINS);
	pushWindow(windows, "Week (all models)", usage.seven_day, SEVEN_DAYS_MINS);

	for (const value of arrayValue(usage.limits).slice(0, MAX_PROVIDER_ITEMS)) {
		const limit = recordValue(value);
		const scope = recordValue(limit?.scope);
		const model = recordValue(scope?.model);
		const modelName = displayString(model?.display_name, MAX_LABEL_LENGTH);
		if (limit?.group !== "weekly" || modelName === undefined) continue;
		windows.push({
			label: `Week (${modelName})`,
			usedPercent: usagePercent(limit),
			windowDurationMins: SEVEN_DAYS_MINS,
			resetsAt: dateField(limit),
		});
	}

	return {
		plan: claudePlanLabel(recordValue(profileValue)),
		windows,
		details: anthropicDetails(usage),
		resetCredits: undefined,
	};
}

async function fetchCodexUsage(token: string, options: ResolvedClientOptions): Promise<ProviderUsageData> {
	const accountId = codexAccountId(token);
	const accountHeaders = accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId };
	const resetHeaders = { ...accountHeaders, "OpenAI-Beta": "codex-1", originator: "Codex Desktop" };
	const [usageValue, resetValue] = await Promise.all([
		getJson("https://chatgpt.com/backend-api/wham/usage", token, requestOptions(options, options.timeoutMs, accountHeaders)),
		getOptionalJson(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
			token,
			requestOptions(options, options.optionalTimeoutMs, resetHeaders),
		),
	]);
	const usage = requireRecord(usageValue);
	const windows: UsageWindow[] = [];
	pushCodexRateLimitWindows(windows, recordValue(usage.rate_limit), "Plan quota", options.now);
	for (const value of arrayValue(usage.additional_rate_limits).slice(0, MAX_PROVIDER_ITEMS)) {
		const entry = recordValue(value);
		const limitName = entry === undefined
			? undefined
			: displayString(firstField(entry, ["limit_name", "limitName", "name", "label", "id"]), MAX_LABEL_LENGTH);
		const sectionLabel = limitName === undefined ? "Model-specific quota" : `${limitName} quota`;
		pushCodexRateLimitWindows(windows, recordValue(entry?.rate_limit), sectionLabel, options.now);
	}

	const details: UsageDetail[] = [];
	const credits = recordValue(usage.credits);
	if (credits !== undefined) {
		const balance = credits.unlimited === true ? "unlimited" : displayScalar(credits.balance);
		const hasCredits = credits.has_credits ?? credits.hasCredits;
		const availability = hasCredits === true ? "available" : hasCredits === false ? "unavailable" : undefined;
		const value = [balance, availability].filter((part): part is string => part !== undefined).join(" · ");
		if (value !== "") details.push({ label: "Account credits", value });
	}
	const summaryCount = countValue(recordValue(usage.rate_limit_reset_credits)?.available_count);

	return {
		plan: displayString(usage.plan_type, MAX_LABEL_LENGTH),
		windows,
		details,
		resetCredits: parseResetCredits(resetValue, summaryCount),
	};
}

async function fetchKimiUsage(token: string, options: ResolvedClientOptions): Promise<ProviderUsageData> {
	const usage = requireRecord(await getJson("https://api.kimi.com/coding/v1/usages", token, requestOptions(options, options.timeoutMs)));
	const windows: UsageWindow[] = [];
	const minuteLimit = arrayValue(usage.limits)
		.slice(0, MAX_PROVIDER_ITEMS)
		.map(recordValue)
		.find((limit) => recordValue(limit?.window)?.timeUnit === "TIME_UNIT_MINUTE");
	const minuteWindow = recordValue(minuteLimit?.window);
	const minuteDetail = recordValue(minuteLimit?.detail);
	if (minuteDetail !== undefined) {
		const duration = numberValue(minuteWindow?.duration) ?? FIVE_HOURS_MINS;
		windows.push({
			label: windowLabel(duration),
			usedPercent: quotaPercent(minuteDetail),
			windowDurationMins: duration,
			resetsAt: dateField(minuteDetail),
		});
	}
	const weekly = recordValue(usage.usage);
	if (weekly !== undefined) {
		windows.push({
			label: "Week",
			usedPercent: quotaPercent(weekly),
			windowDurationMins: SEVEN_DAYS_MINS,
			resetsAt: dateField(weekly),
		});
	}

	const membership = recordValue(recordValue(usage.user)?.membership);
	const rawLevel = displayString(membership?.level, MAX_LABEL_LENGTH);
	const plan = rawLevel?.replace(/^LEVEL_/iu, "").toLowerCase();
	return { plan: plan || undefined, windows, details: [], resetCredits: undefined };
}

async function fetchXaiUsage(token: string, options: ResolvedClientOptions): Promise<ProviderUsageData> {
	const headers = { "X-XAI-Token-Auth": "xai-grok-cli" };
	const [creditsValue, billingValue, settingsValue] = await Promise.all([
		getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", token, requestOptions(options, options.timeoutMs, headers)),
		getOptionalJson("https://cli-chat-proxy.grok.com/v1/billing", token, requestOptions(options, options.optionalTimeoutMs, headers)),
		getOptionalJson("https://cli-chat-proxy.grok.com/v1/settings", token, requestOptions(options, options.optionalTimeoutMs, headers)),
	]);
	const creditsPayload = requireRecord(creditsValue);
	const credits = recordValue(creditsPayload.config) ?? creditsPayload;
	const billing = recordValue(billingValue);
	const settings = recordValue(settingsValue);
	const config = recordValue(billing?.config);
	const windows: UsageWindow[] = [];

	const weeklyPeriod = recordValue(credits.currentPeriod);
	const weeklyStart = dateValue(weeklyPeriod?.start);
	const weeklyEnd = dateValue(weeklyPeriod?.end);
	const weeklyDurationMins = weeklyStart && weeklyEnd
		? Math.max(0, (weeklyEnd.getTime() - weeklyStart.getTime()) / 60_000)
		: SEVEN_DAYS_MINS;
	const weeklyUsed = xaiWeeklyUsedPercent(credits);
	if (weeklyPeriod !== undefined || weeklyUsed !== undefined) {
		windows.push({
			label: "Week (shared pool)",
			usedPercent: weeklyUsed,
			windowDurationMins: weeklyDurationMins,
			resetsAt: weeklyEnd,
		});
	}

	const monthlyUsed = numberValue(recordValue(config?.used)?.val);
	const monthlyLimit = numberValue(recordValue(config?.monthlyLimit)?.val);
	const monthlyStart = dateValue(config?.billingPeriodStart);
	const monthlyEnd = dateValue(config?.billingPeriodEnd);
	const monthlyDurationMins = monthlyStart && monthlyEnd
		? Math.max(0, (monthlyEnd.getTime() - monthlyStart.getTime()) / 60_000)
		: undefined;
	if (monthlyLimit !== undefined && monthlyLimit > 0) {
		windows.push({
			label: "Month (included allowance)",
			usedPercent: ratioPercent(monthlyUsed, monthlyLimit),
			windowDurationMins: monthlyDurationMins,
			resetsAt: monthlyEnd,
		});
	}

	const details: UsageDetail[] = [];
	const productUsage = xaiProductUsage(credits.productUsage ?? credits.product_usage);
	if (productUsage.length > 0) details.push({ label: "Weekly usage split", value: productUsage.join(" · ") });
	if (monthlyUsed !== undefined) {
		const absolute = monthlyLimit !== undefined && monthlyLimit > 0
			? `${formatNumber(monthlyUsed)} / ${formatNumber(monthlyLimit)} used`
			: `${formatNumber(monthlyUsed)} used; no limit reported`;
		details.push({ label: "Monthly included credits", value: absolute });
	}
	return {
		plan: displayString(settings?.subscription_tier_display, MAX_LABEL_LENGTH),
		windows,
		details,
		resetCredits: undefined,
	};
}

function xaiWeeklyUsedPercent(credits: Record<string, unknown>): number | undefined {
	const direct = percentValue(credits.creditUsagePercent ?? credits.credit_usage_percent);
	if (direct !== undefined) return direct;
	let total = 0;
	let found = false;
	for (const value of arrayValue(credits.productUsage ?? credits.product_usage).slice(0, MAX_PROVIDER_ITEMS)) {
		const product = recordValue(value);
		const used = product === undefined ? undefined : usagePercent(product);
		if (used === undefined) continue;
		total += used;
		found = true;
	}
	return found ? percentValue(total) : undefined;
}

function xaiProductUsage(value: unknown): string[] {
	const details: string[] = [];
	for (const rawProduct of arrayValue(value).slice(0, MAX_PROVIDER_ITEMS)) {
		const product = recordValue(rawProduct);
		const rawName = displayString(product?.product, MAX_LABEL_LENGTH);
		const used = product === undefined ? undefined : usagePercent(product);
		if (rawName === undefined || used === undefined) continue;
		details.push(`${xaiProductLabel(rawName)} ${formatNumber(used)}% used`);
	}
	return details;
}

function xaiProductLabel(value: string): string {
	if (value === "Api") return "xAI API";
	if (value === "GrokBuild") return "Grok Build";
	if (value === "GrokChat") return "Grok Chat";
	return value.replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function pushCodexRateLimitWindows(
	windows: UsageWindow[],
	rateLimit: Record<string, unknown> | undefined,
	sectionLabel: string,
	now: Date,
): void {
	for (const value of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
		const window = recordValue(value);
		if (window === undefined) continue;
		const durationSeconds = numberField(window, ["limit_window_seconds", "limitWindowSeconds", "window_duration_seconds", "windowDurationSeconds"]);
		const durationMins = durationSeconds === undefined ? undefined : durationSeconds / 60;
		const label = windowLabel(durationMins);
		windows.push({
			label,
			sectionLabel,
			usedPercent: usagePercent(window),
			windowDurationMins: durationMins,
			resetsAt: codexResetAt(window, now),
		});
	}
}

function codexResetAt(window: Record<string, unknown>, now: Date): Date | undefined {
	const absolute = dateField(window);
	if (absolute !== undefined) return absolute;
	const afterSeconds = numberField(window, ["reset_after_seconds", "resetAfterSeconds"]);
	if (afterSeconds === undefined || afterSeconds < 0) return undefined;
	return new Date(now.getTime() + afterSeconds * 1_000);
}

function parseResetCredits(value: unknown, fallbackCount: number | undefined): UsageResetCredits | undefined {
	const payload = recordValue(value);
	let credits: UsageResetCredit[] | undefined;
	if (Array.isArray(payload?.credits)) {
		credits = [];
		for (const rawCredit of payload.credits.slice(0, MAX_RESET_CREDITS)) {
			const credit = parseResetCredit(rawCredit);
			if (credit !== undefined) credits.push(credit);
		}
	}
	const endpointCount = countValue(payload?.available_count ?? payload?.availableCount);
	const derivedCount = credits?.filter((credit) => credit.status === "available").length;
	const availableCount = endpointCount ?? fallbackCount ?? derivedCount;
	return availableCount === undefined ? undefined : { availableCount, credits };
}

function parseResetCredit(value: unknown): UsageResetCredit | undefined {
	const credit = recordValue(value);
	if (credit === undefined) return undefined;
	return {
		status: displayString(credit.status, MAX_LABEL_LENGTH) ?? "unknown",
		grantedAt: dateValue(credit.granted_at ?? credit.grantedAt),
		expiresAt: dateValue(credit.expires_at ?? credit.expiresAt),
	};
}

function anthropicDetails(usage: Record<string, unknown>): UsageDetail[] {
	const extra = recordValue(usage.extra_usage);
	if (extra?.credits_ever_enabled !== true) return [];
	const spend = recordValue(usage.spend);
	const spendUsed = recordValue(spend?.used);
	const spendLimit = recordValue(spend?.limit);
	const used = moneyValue(spendUsed?.amount_minor ?? extra.used_credits, spendUsed?.exponent ?? extra.decimal_places);
	const limit = moneyValue(spendLimit?.amount_minor ?? extra.monthly_limit, spendLimit?.exponent ?? extra.decimal_places);
	if (used === undefined || limit === undefined) return [];
	const currency = displayString(spendUsed?.currency ?? extra.currency, 12);
	const amount = `${currency ? `${currency} ` : ""}${used} / ${limit}`;
	return [{ label: "Extra usage", value: extra.is_enabled === true ? amount : `disabled (${amount} spent)` }];
}

function claudePlanLabel(profile: Record<string, unknown> | undefined): string | undefined {
	const organization = recordValue(profile?.organization);
	const account = recordValue(profile?.account);
	const tier = displayString(organization?.rate_limit_tier, MAX_LABEL_LENGTH);
	const maxMatch = tier === undefined ? undefined : /claude_max_(\d+)x/iu.exec(tier);
	if (maxMatch?.[1]) return `Max x${maxMatch[1]}`;
	if (account?.has_claude_max === true || organization?.organization_type === "claude_max") return "Max";
	if (account?.has_claude_pro === true) return "Pro";
	return undefined;
}

function pushWindow(windows: UsageWindow[], label: string, value: unknown, durationMins: number): void {
	const record = recordValue(value);
	if (record === undefined) return;
	windows.push({
		label,
		usedPercent: usagePercent(record),
		windowDurationMins: durationMins,
		resetsAt: dateField(record),
	});
}

function requestOptions(options: ResolvedClientOptions, timeoutMs: number, headers: Record<string, string> = {}): JsonRequestOptions {
	return { fetchImpl: options.fetchImpl, parentSignal: options.signal, timeoutMs, headers };
}

async function getOptionalJson(url: string, token: string, options: JsonRequestOptions): Promise<unknown | undefined> {
	try {
		return await getJson(url, token, options);
	} catch (error) {
		if (error instanceof UsageRequestError && error.code === "aborted") throw error;
		return undefined;
	}
}

async function getJson(url: string, token: string, options: JsonRequestOptions): Promise<unknown> {
	const abort = createAbort(options.parentSignal, options.timeoutMs);
	try {
		const response = await options.fetchImpl(url, {
			signal: abort.signal,
			headers: { ...options.headers, Authorization: `Bearer ${token}`, Accept: "application/json" },
		});
		if (response.status < 200 || response.status >= 300) {
			await response.body?.cancel().catch(() => undefined);
			throw new UsageRequestError("http", response.status);
		}
		const declaredBytes = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
			await response.body?.cancel().catch(() => undefined);
			throw new UsageRequestError("response_too_large");
		}
		const text = await readBody(response, MAX_RESPONSE_BYTES);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new UsageRequestError("invalid_response");
		}
	} catch (error) {
		if (abort.signal.aborted) {
			throw new UsageRequestError(options.parentSignal?.aborted ? "aborted" : "timeout");
		}
		if (error instanceof UsageRequestError) throw error;
		throw new UsageRequestError("request_failed");
	} finally {
		abort.dispose();
	}
}

async function readBody(response: UsageHttpResponse, maxBytes: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		if (chunk.value === undefined) continue;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new UsageRequestError("response_too_large");
		}
		chunks.push(Buffer.from(chunk.value));
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

function createAbort(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

async function defaultFetch(url: string, request: UsageHttpRequest): Promise<UsageHttpResponse> {
	const response = await fetch(url, { signal: request.signal, headers: request.headers, redirect: "error" });
	const body = response.body;
	return {
		status: response.status,
		headers: response.headers,
		body: body === null ? null : {
			getReader() {
				const reader = body.getReader();
				return {
					async read() {
						const chunk = await reader.read();
						return chunk.value === undefined ? { done: chunk.done } : { done: chunk.done, value: chunk.value };
					},
					cancel: () => reader.cancel(),
				};
			},
			cancel: () => body.cancel(),
		},
	};
}

function providerError(provider: ProviderDefinition, error: UsageProviderError): ProviderUsage {
	return { id: provider.id, name: provider.name, status: "error", error };
}

function toProviderError(error: unknown): UsageProviderError {
	if (!(error instanceof UsageRequestError)) return { code: "request_failed", httpStatus: undefined };
	if (error.code === "http") return { code: "http", httpStatus: error.httpStatus };
	if (error.code === "timeout") return { code: "timeout", httpStatus: undefined };
	if (error.code === "response_too_large") return { code: "response_too_large", httpStatus: undefined };
	if (error.code === "invalid_response") return { code: "invalid_response", httpStatus: undefined };
	return { code: "request_failed", httpStatus: undefined };
}

function codexAccountId(token: string): string | undefined {
	try {
		const payloadPart = token.split(".")[1];
		if (payloadPart === undefined) return undefined;
		const payload = recordValue(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown);
		const auth = recordValue(payload?.["https://api.openai.com/auth"]);
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(accountId) ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function windowLabel(durationMins: number | undefined): string {
	if (durationMins === undefined || durationMins <= 0) return "Session";
	if (durationMins === SEVEN_DAYS_MINS) return "Week";
	if (durationMins % 1440 === 0) return `Session (${durationMins / 1440}d)`;
	if (durationMins % 60 === 0) return `Session (${durationMins / 60}h)`;
	return `Session (${formatNumber(durationMins)}m)`;
}

function requireRecord(value: unknown): Record<string, unknown> {
	const record = recordValue(value);
	if (record === undefined) throw new UsageRequestError("invalid_response");
	return record;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : undefined;
	return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function percentValue(value: unknown): number | undefined {
	const number = numberValue(value);
	return number === undefined ? undefined : Math.max(0, Math.min(100, number));
}

function usagePercent(value: Record<string, unknown>): number | undefined {
	const used = percentValue(firstField(value, [
		"used_percent",
		"usedPercent",
		"used_percentage",
		"usedPercentage",
		"utilization",
		"percent",
		"usage_percent",
		"usagePercent",
	]));
	if (used !== undefined) return used;
	const remaining = percentValue(firstField(value, ["remaining_percent", "remainingPercent", "remaining_percentage", "remainingPercentage"]));
	return remaining === undefined ? undefined : 100 - remaining;
}

function numberField(value: Record<string, unknown>, fields: readonly string[]): number | undefined {
	return numberValue(firstField(value, fields));
}

function dateField(value: Record<string, unknown>): Date | undefined {
	return dateValue(firstField(value, ["resets_at", "resetsAt", "reset_at", "resetAt", "reset_time", "resetTime"]));
}

function firstField(value: Record<string, unknown>, fields: readonly string[]): unknown {
	for (const field of fields) {
		if (value[field] !== undefined && value[field] !== null) return value[field];
	}
	return undefined;
}

function quotaPercent(value: Record<string, unknown>): number | undefined {
	const direct = usagePercent(value) ?? ratioPercent(value.used, value.limit);
	if (direct !== undefined) return direct;
	const remaining = numberValue(value.remaining);
	const limit = numberValue(value.limit);
	return remaining === undefined || limit === undefined || limit <= 0 ? undefined : percentValue(((limit - remaining) / limit) * 100);
}

function ratioPercent(usedValue: unknown, limitValue: unknown): number | undefined {
	const used = numberValue(usedValue);
	const limit = numberValue(limitValue);
	return used === undefined || limit === undefined || limit <= 0 ? undefined : percentValue((used / limit) * 100);
}

function countValue(value: unknown): number | undefined {
	const number = numberValue(value);
	return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function dateValue(value: unknown): Date | undefined {
	const milliseconds = typeof value === "number"
		? value < 1_000_000_000_000 ? value * 1_000 : value
		: typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(milliseconds)) return undefined;
	const date = new Date(milliseconds);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function displayString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
		.trim()
		.slice(0, maxLength);
	return clean || undefined;
}

function displayScalar(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return formatNumber(value);
	return displayString(value, MAX_DETAIL_LENGTH);
}

function moneyValue(value: unknown, exponentValue: unknown): string | undefined {
	const amount = numberValue(value);
	if (amount === undefined) return undefined;
	const exponent = Math.max(0, Math.min(6, Math.trunc(numberValue(exponentValue) ?? 0)));
	return (amount / 10 ** exponent).toFixed(exponent);
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
