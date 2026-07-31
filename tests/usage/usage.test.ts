import type { AuthResult } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import usageExtension from "../../agent/extensions/usage.js";
import {
	collectUsageSnapshot,
	type UsageContext,
	type UsageFetch,
	type UsageHttpRequest,
	type UsageHttpResponse,
} from "../../src/usage/client.js";
import { renderUsage, renderUsageError } from "../../src/usage/presentation/render.js";
import { serializeUsageSnapshot, UsageService } from "../../src/usage/service.js";
import { UsageRequestError, type UsageSnapshot } from "../../src/usage/types.js";
import { UsageViewer } from "../../src/usage/tui/viewer.js";
import { httpResponse } from "../helpers/http.js";

const NOW = new Date("2026-07-27T00:00:00Z");
const CODEX_ACCOUNT_ID = "account_123";
const CODEX_TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: CODEX_ACCOUNT_ID } });

interface CapturedRequest {
	url: string;
	request: UsageHttpRequest;
}

describe("usage client", () => {
	it("通过 Pi OAuth 并发解析四种官方 plan", async () => {
		const requests: CapturedRequest[] = [];
		const snapshot = await collectUsageSnapshot(oauthContext(), { fetchImpl: fixtureFetch(requests), now: NOW });

		expect(snapshot.providers).toHaveLength(4);
		expect(provider(snapshot, "anthropic")).toMatchObject({
			status: "ok",
			plan: "Pro",
			windows: [
				{ label: "Session (5h)", usedPercent: 25 },
				{ label: "Week (all models)", usedPercent: 50 },
				{ label: "Week (Sonnet)", usedPercent: 60 },
			],
			details: [{ label: "Extra usage", value: "USD 12.34 / 50.00" }],
		});
		expect(provider(snapshot, "openai-codex")).toMatchObject({
			status: "ok",
			plan: "pro",
			windows: [
				{ label: "Session (5h)", sectionLabel: "Plan quota", usedPercent: 20 },
				{ label: "Week", sectionLabel: "Plan quota", usedPercent: 70 },
				{
					label: "Session (1h)",
					sectionLabel: "GPT-5.3-Codex-Spark quota",
					usedPercent: 40,
					resetsAt: new Date("2026-07-27T00:30:00Z"),
				},
			],
			details: [{ label: "Account credits", value: "9 · available" }],
			resetCredits: {
				availableCount: 2,
				credits: [
					{
						status: "available",
						grantedAt: new Date("2026-07-12T00:00:00Z"),
						expiresAt: new Date("2026-08-12T00:00:00Z"),
					},
					{
						status: "available",
						grantedAt: new Date("2026-07-13T00:00:00Z"),
						expiresAt: new Date("2026-08-13T00:00:00Z"),
					},
				],
			},
		});
		expect(provider(snapshot, "kimi-coding")).toMatchObject({
			status: "ok",
			plan: "ultra",
			windows: [{ label: "Session (5h)", usedPercent: 25 }, { label: "Week", usedPercent: 50 }],
		});
		expect(provider(snapshot, "xai")).toMatchObject({
			status: "ok",
			plan: "SuperGrok",
			windows: [
				{ label: "Week (shared pool)", usedPercent: 56, resetsAt: new Date("2026-08-03T00:00:00Z") },
				{ label: "Month (included allowance)", usedPercent: 25 },
			],
			details: [
				{ label: "Weekly usage split", value: "xAI API 33% used · Grok Build 23% used" },
				{ label: "Monthly included credits", value: "250 / 1000 used" },
			],
		});

		expect(requests.every(({ request }) => request.headers.Authorization?.startsWith("Bearer "))).toBe(true);
		const codexRequest = requests.find(({ url }) => url.endsWith("/wham/usage"));
		expect(codexRequest?.request.headers["ChatGPT-Account-Id"]).toBe(CODEX_ACCOUNT_ID);
		const resetRequest = requests.find(({ url }) => url.endsWith("/wham/rate-limit-reset-credits"));
		expect(resetRequest?.request.headers).toMatchObject({
			"ChatGPT-Account-Id": CODEX_ACCOUNT_ID,
			"OpenAI-Beta": "codex-1",
			originator: "Codex Desktop",
		});
		const grokRequest = requests.find(({ url }) => url.endsWith("/v1/billing?format=credits"));
		expect(grokRequest?.request.headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
	});

	it("Grok 周总量缺失时使用产品占比合计", async () => {
		const snapshot = await collectUsageSnapshot(oauthContext(), {
			fetchImpl: async (url, request) => url.endsWith("/v1/billing?format=credits")
				? jsonResponse({ config: {
					currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-03T00:00:00Z" },
					productUsage: [
						{ product: "Api", usagePercent: 12 },
						{ product: "GrokBuild", usagePercent: 8 },
					],
				} })
				: fixtureResponse(url, request),
			now: NOW,
		});

		expect(provider(snapshot, "xai")).toMatchObject({
			status: "ok",
			windows: expect.arrayContaining([expect.objectContaining({ label: "Week (shared pool)", usedPercent: 20 })]),
		});
	});

	it("拒绝 API key，并且不访问订阅端点", async () => {
		const fetchImpl = vi.fn<UsageFetch>();
		const context: UsageContext = {
			modelRegistry: {
				getProviderAuth: async (): Promise<AuthResult> => ({ source: "ANTHROPIC_API_KEY", auth: { apiKey: "secret-api-key" } }),
			},
		};

		const snapshot = await collectUsageSnapshot(context, { fetchImpl, now: NOW });

		expect(snapshot.providers.every((value) => value.status === "not_logged_in")).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("隔离 provider 失败，且结果和渲染不暴露响应正文或 token", async () => {
		const secret = "remote-secret-body";
		const token = "oauth-secret-token";
		const fetchImpl: UsageFetch = async (url, request) => {
			if (url.endsWith("/api/oauth/usage")) return httpResponse(503, secret);
			return fixtureResponse(url, request);
		};
		const snapshot = await collectUsageSnapshot(oauthContext(token), { fetchImpl, now: NOW });
		const output = renderUsage(serializeUsageSnapshot(snapshot), 96).join("\n");

		expect(provider(snapshot, "anthropic")).toMatchObject({ status: "error", error: { code: "http", httpStatus: 503 } });
		expect(provider(snapshot, "openai-codex")).toMatchObject({ status: "ok" });
		expect(output).not.toContain(secret);
		expect(output).not.toContain(token);
	});

	it("重置卡详情查询失败时保留 Codex usage 和可用数量", async () => {
		const snapshot = await collectUsageSnapshot(oauthContext(), {
			fetchImpl: async (url, request) => url.endsWith("/wham/rate-limit-reset-credits")
				? httpResponse(503, "untrusted error")
				: fixtureResponse(url, request),
			now: NOW,
		});
		expect(provider(snapshot, "openai-codex")).toMatchObject({
			status: "ok",
			resetCredits: { availableCount: 2, credits: undefined },
		});
	});

	it.each([
		["invalid_response", () => httpResponse(200, "not-json")],
		["response_too_large", () => httpResponse(200, "{}", { "content-length": "1048577" })],
	] as const)("将不可信响应归一化为 %s", async (code, response) => {
		const snapshot = await collectUsageSnapshot(oauthContext(), {
			fetchImpl: async () => response(),
			now: NOW,
		});
		expect(snapshot.providers.every((value) => value.status === "error" && value.error.code === code)).toBe(true);
	});

	it("区分 provider 超时和外部取消", async () => {
		vi.useFakeTimers();
		try {
			const hangingFetch: UsageFetch = async (_url, request) => new Promise<UsageHttpResponse>((_resolve, reject) => {
				const abort = () => reject(new Error("request stopped"));
				if (request.signal.aborted) abort();
				else request.signal.addEventListener("abort", abort, { once: true });
			});

			const timedOut = collectUsageSnapshot(oauthContext(), {
				fetchImpl: hangingFetch,
				timeoutMs: 100,
				optionalTimeoutMs: 100,
				now: NOW,
			});
			await vi.advanceTimersByTimeAsync(100);
			const timedOutSnapshot = await timedOut;
			expect(timedOutSnapshot.providers.every((value) => value.status === "error" && value.error.code === "timeout")).toBe(true);

			const controller = new AbortController();
			const cancelled = collectUsageSnapshot(oauthContext(), { fetchImpl: hangingFetch, signal: controller.signal, now: NOW });
			controller.abort();
			await expect(cancelled).rejects.toMatchObject({ code: "aborted" });
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

describe("usage service", () => {
	it("缓存 60 秒，并由 refresh 绕过缓存", async () => {
		let now = NOW.getTime();
		let authReads = 0;
		const context: UsageContext = {
			modelRegistry: {
				getProviderAuth: async () => {
					authReads += 1;
					return undefined;
				},
			},
		};
		const service = new UsageService({ clock: () => now });

		const first = await service.load(context);
		const cached = await service.load(context);
		expect(cached).toBe(first);
		expect(authReads).toBe(4);

		await service.load(context, { refresh: true });
		expect(authReads).toBe(8);

		now += 60_001;
		await service.load(context);
		expect(authReads).toBe(12);
	});

	it("合并并发刷新，避免重复读取 OAuth", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let authReads = 0;
		const context: UsageContext = {
			modelRegistry: {
				async getProviderAuth() {
					authReads += 1;
					await gate;
					return undefined;
				},
			},
		};
		const service = new UsageService();
		const first = service.load(context, { refresh: true });
		const second = service.load(context, { refresh: true });
		release?.();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(secondSnapshot).toBe(firstSnapshot);
		expect(authReads).toBe(4);
	});
});

describe("usage renderer", () => {
	it.each([100, 42])("宽度 %i 下不越界并保留用量信息", async (width) => {
		const snapshot = serializeUsageSnapshot(await collectUsageSnapshot(oauthContext(), { fetchImpl: fixtureFetch(), now: NOW }));
		const lines = renderUsage(snapshot, width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("% remaining");
		expect(lines.join("\n")).toContain("Expires in");
		expect(lines.join("\n")).toContain("GPT-5.3-Codex-Spark quota");
		expect(lines.join("\n")).not.toContain("Additional quota");
		expect(lines.join("\n")).not.toContain("One free rate limit reset");
	});

	it("隐藏未登录 provider", async () => {
		const snapshot = serializeUsageSnapshot(await collectUsageSnapshot({ modelRegistry: { getProviderAuth: async () => undefined } }, { now: NOW }));
		const output = renderUsage(snapshot, 80).join("\n");
		expect(output).toContain("No logged-in supported plan providers.");
		expect(output).not.toContain("OAuth not logged in");
		expect(output).not.toContain("Claude");
		expect(output).not.toContain("Codex");
	});

	it("缺少百分比时只显示一次可用性提示", () => {
		const snapshot: UsageSnapshot = {
			generatedAt: NOW.toISOString(),
			timeZone: "UTC",
			providers: [{
				id: "anthropic",
				name: "Claude",
				status: "ok",
				plan: "Pro",
				windows: [{ label: "Session (5h)", usedPercent: undefined, windowDurationMins: 300, resetsAt: "2026-07-27T05:00:00.000Z" }],
				details: [],
				resetCredits: undefined,
			}],
		};
		const output = renderUsage(snapshot, 100).join("\n");
		expect(output).toContain("[--------------------] usage unavailable");
		expect(output).not.toContain("unknown unknown");
	});

	it("再次清理 plan 中的终端控制字符，错误渲染不泄露底层消息", () => {
		const snapshot: UsageSnapshot = {
			generatedAt: NOW.toISOString(),
			timeZone: "UTC",
			providers: [{
				id: "xai",
				name: "Grok",
				status: "ok",
				plan: "Super\u001b[31mGrok\u202e",
				windows: [],
				details: [],
				resetCredits: undefined,
			}],
		};
		const output = renderUsage(snapshot, 80).join("\n");
		const error = renderUsageError(new Error("oauth-secret-token"), 80).join("\n");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u202e");
		expect(error).not.toContain("oauth-secret-token");
		expect(renderUsageError(new UsageRequestError("aborted"), 80).join("\n")).toContain("cancelled");
	});

	it("viewer 可渲染成功和错误结果并响应关闭键", async () => {
		const snapshot = serializeUsageSnapshot(await collectUsageSnapshot(oauthContext(), { fetchImpl: fixtureFetch(), now: NOW }));
		let closed = 0;
		let boldCalls = 0;
		const theme: Pick<Theme, "fg" | "bold"> = {
			fg(_name, text) {
				return text;
			},
			bold(text) {
				boldCalls += 1;
				return text;
			},
		};
		const viewer = new UsageViewer(snapshot, theme, () => 20, () => {
			closed += 1;
		});
		expect(viewer.render(80).length).toBeGreaterThan(0);
		expect(boldCalls).toBe(4);
		viewer.handleInput("q");
		expect(closed).toBe(1);
		expect(new UsageViewer(new Error("secret"), theme, () => 20, () => {}).render(80).join("\n")).not.toContain("secret");
	});
});

describe("usage extension", () => {
	it("注册 /usage、校验参数并使用只读浮层布局", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;
		let customOptions: unknown;
		const notifications: string[] = [];
		const pi = {
			registerCommand(name, options) {
				commandName = name;
				commandOptions = options;
			},
		} satisfies Pick<ExtensionAPI, "registerCommand">;
		usageExtension(pi);

		const context = fixture<Parameters<CommandOptions["handler"]>[1]>({
			mode: "tui",
			signal: undefined,
			modelRegistry: { getProviderAuth: async () => undefined },
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				async custom(_factory: unknown, options: unknown) {
					customOptions = options;
				},
			},
		});
		await commandOptions?.handler("bad", context);
		expect(notifications).toEqual(["Usage: /usage [--refresh]"]);

		await commandOptions?.handler("", context);
		expect(commandName).toBe("usage");
		expect(customOptions).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", minWidth: 110, margin: 1 },
		});

		let printNotification: { message: string; type: string | undefined } | undefined;
		await commandOptions?.handler("--refresh", fixture<Parameters<CommandOptions["handler"]>[1]>({
			mode: "print",
			signal: undefined,
			modelRegistry: { getProviderAuth: async () => undefined },
			ui: {
				notify(message: string, type: string | undefined) {
					printNotification = { message, type };
				},
			},
		}));
		expect(printNotification).toMatchObject({ message: expect.stringContaining("Plan Usage"), type: "info" });
	});
});

function oauthContext(defaultToken = "oauth-token"): UsageContext {
	return {
		modelRegistry: {
			getProviderAuth: async (providerId): Promise<AuthResult> => ({
				source: "OAuth",
				auth: providerId === "kimi-coding"
					? { headers: { Authorization: `Bearer ${defaultToken}` } }
					: { apiKey: providerId === "openai-codex" ? CODEX_TOKEN : defaultToken },
			}),
		},
	};
}

function fixtureFetch(requests: CapturedRequest[] = []): UsageFetch {
	return async (url, request) => {
		requests.push({ url, request });
		return fixtureResponse(url, request);
	};
}

function fixtureResponse(url: string, _request: UsageHttpRequest): UsageHttpResponse {
	if (url.endsWith("/api/oauth/usage")) {
		return jsonResponse({
			five_hour: { remainingPercent: 75, resetsAt: "2026-07-27T05:00:00Z" },
			seven_day: { utilization: 50, resets_at: "2026-08-03T00:00:00Z" },
			limits: [{ group: "weekly", percent: 60, resets_at: "2026-08-03T00:00:00Z", scope: { model: { display_name: "Sonnet" } } }],
			extra_usage: { credits_ever_enabled: true, is_enabled: true, used_credits: 1234, monthly_limit: 5000, decimal_places: 2, currency: "USD" },
		});
	}
	if (url.endsWith("/api/oauth/profile")) return jsonResponse({ account: { has_claude_pro: true }, organization: {} });
	if (url.endsWith("/wham/usage")) {
		return jsonResponse({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_785_153_600 },
				secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: 1_785_672_000 },
			},
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: { primary_window: { usedPercent: 40, limitWindowSeconds: 3_600, resetAfterSeconds: 1_800 } },
			}],
			rate_limit_reset_credits: { available_count: 2 },
			credits: { has_credits: true, balance: "9" },
		});
	}
	if (url.endsWith("/wham/rate-limit-reset-credits")) {
		return jsonResponse({
			available_count: 2,
			credits: [
				{
					id: "RateLimitResetCredit_1",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-07-12T00:00:00Z",
					expires_at: "2026-08-12T00:00:00Z",
					title: "One free rate limit reset",
					description: "Free reset",
				},
				{
					id: "RateLimitResetCredit_2",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-07-13T00:00:00Z",
					expires_at: "2026-08-13T00:00:00Z",
					title: "Referral reset",
				},
			],
		});
	}
	if (url.endsWith("/coding/v1/usages")) {
		return jsonResponse({
			user: { membership: { level: "LEVEL_ULTRA" } },
			limits: [{ window: { timeUnit: "TIME_UNIT_MINUTE", duration: 300 }, detail: { remaining: "75", limit: "100", resetTime: "2026-07-27T05:00:00Z" } }],
			usage: { used: 4, limit: 8, resetTime: "2026-08-03T00:00:00Z" },
		});
	}
	if (url.endsWith("/v1/billing?format=credits")) {
		return jsonResponse({ config: {
			creditUsagePercent: 56,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-07-27T00:00:00Z",
				end: "2026-08-03T00:00:00Z",
			},
			productUsage: [
				{ product: "Api", usagePercent: 33 },
				{ product: "GrokBuild", usagePercent: 23 },
			],
		} });
	}
	if (url.endsWith("/v1/billing")) {
		return jsonResponse({ config: {
			used: { val: 250 },
			monthlyLimit: { val: 1000 },
			billingPeriodStart: "2026-07-01T00:00:00Z",
			billingPeriodEnd: "2026-08-01T00:00:00Z",
		} });
	}
	if (url.endsWith("/v1/settings")) return jsonResponse({ subscription_tier_display: "SuperGrok" });
	throw new Error(`Unexpected test URL: ${url}`);
}

function jsonResponse(value: unknown): UsageHttpResponse {
	return httpResponse(200, JSON.stringify(value), { "content-type": "application/json" });
}

function provider<T extends { providers: Array<{ id: string }> }>(snapshot: T, id: string): T["providers"][number] {
	const value = snapshot.providers.find((item) => item.id === id);
	if (value === undefined) throw new Error(`Missing provider ${id}`);
	return value;
}

function jwt(payload: unknown): string {
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function fixture<T>(value: unknown): T {
	return value as T;
}
