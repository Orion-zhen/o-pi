import type { AuthResult } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import usageExtension from "../../agent/extensions/usage.js";
import { collectUsageSnapshot, type UsageContext } from "../../src/usage/client.js";
import { renderUsage, renderUsageCancelled } from "../../src/usage/presentation/render.js";
import { UsageService } from "../../src/usage/service.js";
import { UsageViewer } from "../../src/usage/tui/viewer.js";

const NOW = new Date("2026-07-27T00:00:00Z");
const CODEX_ACCOUNT_ID = "account_123";
const CODEX_TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: CODEX_ACCOUNT_ID } });

interface CapturedRequest {
	url: string;
	request: RequestInit;
}

describe("usage client", () => {
	it("通过 Pi OAuth 解析四种当前官方 plan 响应", async () => {
		const requests: CapturedRequest[] = [];
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fixtureFetch(requests)));

		expect(snapshot.providers).toHaveLength(4);
		expect(provider(snapshot, "anthropic")).toMatchObject({
			status: "ok",
			plan: undefined,
			windows: expect.arrayContaining([expect.objectContaining({ label: "Week (Sonnet)", usedPercent: 60 })]),
			details: [{ label: "Extra usage", value: "USD 12.34 / 50" }],
		});
		expect(provider(snapshot, "openai-codex")).toMatchObject({
			status: "ok",
			plan: "pro",
			windows: expect.arrayContaining([expect.objectContaining({ usedPercent: 40 })]),
			resetCredits: { availableCount: 2 },
		});
		expect(provider(snapshot, "kimi-coding")).toMatchObject({
			status: "ok",
			plan: undefined,
			windows: expect.arrayContaining([expect.objectContaining({ usedPercent: 25 })]),
		});
		expect(provider(snapshot, "xai")).toMatchObject({
			status: "ok",
			plan: "SuperGrok",
			windows: expect.arrayContaining([
				expect.objectContaining({ label: "Week (included allowance)", usedPercent: 56 }),
				expect.objectContaining({ label: "Month (included allowance)", usedPercent: 25 }),
			]),
		});

		const urls = requests.map(({ url }) => url);
		expect(urls).toEqual(expect.arrayContaining([
			"https://api.anthropic.com/api/oauth/usage",
			"https://chatgpt.com/backend-api/wham/usage",
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
			"https://api.kimi.com/coding/v1/usages",
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
			"https://cli-chat-proxy.grok.com/v1/settings",
		]));
		expect(urls).not.toContain("https://api.anthropic.com/api/oauth/profile");
		expect(urls).not.toContain("https://cli-chat-proxy.grok.com/v1/billing");
		expect(requests.every(({ request }) => new Headers(request.headers).get("Authorization")?.startsWith("Bearer "))).toBe(true);
		const codexRequest = requests.find(({ url }) => url.endsWith("/wham/usage"));
		expect(new Headers(codexRequest?.request.headers).get("ChatGPT-Account-Id")).toBe(CODEX_ACCOUNT_ID);
		const grokRequest = requests.find(({ url }) => url.endsWith("/v1/billing?format=credits"));
		expect(new Headers(grokRequest?.request.headers).get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
	});

	it("拒绝 API key，并且不访问订阅端点", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const context: UsageContext = {
			modelRegistry: {
				getProviderAuth: async (): Promise<AuthResult> => ({ source: "ANTHROPIC_API_KEY", auth: { apiKey: "secret-api-key" } }),
			},
		};

		const snapshot = await collectUsageSnapshot(context, clientOptions(fetchImpl));

		expect(snapshot.providers.every((value) => value.status === "not_logged_in")).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("隔离 provider 失败，且结果和渲染不暴露响应正文或 token", async () => {
		const secret = "remote-secret-body";
		const token = "oauth-secret-token";
		const fetchImpl: typeof fetch = async (input) => {
			const url = requestUrl(input);
			if (url.endsWith("/api/oauth/usage")) return new Response(secret, { status: 503 });
			return fixtureResponse(url);
		};
		const snapshot = await collectUsageSnapshot(oauthContext(token), clientOptions(fetchImpl));
		const output = renderUsage(snapshot, 96).join("\n");

		expect(provider(snapshot, "anthropic")).toMatchObject({ status: "error", error: { code: "http", httpStatus: 503 } });
		expect(provider(snapshot, "openai-codex")).toMatchObject({ status: "ok" });
		expect(output).not.toContain(secret);
		expect(output).not.toContain(token);
	});

	it("重置卡详情查询失败时保留 Codex usage 和可用数量", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = requestUrl(input);
			return url.endsWith("/wham/rate-limit-reset-credits")
				? new Response("untrusted error", { status: 503 })
				: fixtureResponse(url);
		};
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fetchImpl));

		expect(provider(snapshot, "openai-codex")).toMatchObject({
			status: "ok",
			resetCredits: { availableCount: 2, credits: undefined },
		});
	});

	it.each([
		["invalid_response", () => new Response("not-json")],
		["response_too_large", () => new Response(Buffer.alloc(1_048_577))],
	] as const)("将不可信响应归一化为 %s", async (code, response) => {
		const fetchImpl: typeof fetch = async () => response();
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fetchImpl));
		expect(snapshot.providers.every((value) => value.status === "error" && value.error.code === code)).toBe(true);
	});

	it("区分 provider 超时和外部取消", async () => {
		const hangingFetch: typeof fetch = async (_input, request) => new Promise<Response>((_resolve, reject) => {
			const signal = request?.signal;
			if (signal === undefined || signal === null) throw new Error("Missing request signal");
			const abort = () => reject(new Error("request stopped"));
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});
		const timeoutController = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		try {
			const timedOut = collectUsageSnapshot(oauthContext(), clientOptions(hangingFetch));
			timeoutController.abort();
			const timedOutSnapshot = await timedOut;
			expect(timedOutSnapshot.providers.every((value) => value.status === "error" && value.error.code === "timeout")).toBe(true);
		} finally {
			timeout.mockRestore();
		}

		const controller = new AbortController();
		const cancelled = collectUsageSnapshot(oauthContext(), {
			...clientOptions(hangingFetch),
			signal: controller.signal,
		});
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ code: "aborted" });
	});

	it("在网络边界清理 provider 动态文本", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = requestUrl(input);
			return url.endsWith("/v1/settings")
				? jsonResponse({ subscription_tier_display: "Super\u001b[31mGrok\u202e" })
				: fixtureResponse(url);
		};
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fetchImpl));
		const output = renderUsage(snapshot, 80).join("\n");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u202e");
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

		const first = await service.load(context, loadOptions());
		const cached = await service.load(context, loadOptions());
		expect(cached).toBe(first);
		expect(authReads).toBe(4);

		await service.load(context, loadOptions(true));
		expect(authReads).toBe(8);

		now += 60_001;
		await service.load(context, loadOptions());
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
		const first = service.load(context, loadOptions(true));
		const second = service.load(context, loadOptions(true));
		release?.();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(secondSnapshot).toBe(firstSnapshot);
		expect(authReads).toBe(4);
	});
});

describe("usage renderer", () => {
	it.each([100, 42])("宽度 %i 下不越界并保留用量信息", async (width) => {
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fixtureFetch()));
		const lines = renderUsage(snapshot, width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("GPT-5.3-Codex-Spark quota");
	});

	it("隐藏未登录 provider", async () => {
		const snapshot = await collectUsageSnapshot(
			{ modelRegistry: { getProviderAuth: async () => undefined } },
			clientOptions(fixtureFetch()),
		);
		const output = renderUsage(snapshot, 80).join("\n");
		expect(output.length).toBeGreaterThan(0);
		expect(output).not.toContain("Claude");
		expect(output).not.toContain("Codex");
	});

	it("viewer 可渲染成功和取消结果并响应关闭键", async () => {
		const snapshot = await collectUsageSnapshot(oauthContext(), clientOptions(fixtureFetch()));
		let closed = 0;
		const theme: Pick<Theme, "fg" | "bold"> = {
			fg: (_name, text) => text,
			bold: (text) => text,
		};
		const viewer = new UsageViewer(snapshot, theme, () => 20, () => {
			closed += 1;
		});
		expect(viewer.render(80).length).toBeGreaterThan(0);
		viewer.handleInput("q");
		expect(closed).toBe(1);
		expect(new UsageViewer("aborted", theme, () => 20, () => {}).render(80).length).toBeGreaterThan(0);
		expect(renderUsageCancelled(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
});

describe("usage extension", () => {
	it("注册 /usage、校验参数并按运行模式展示", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;
		let customCalled = false;
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
				async custom() {
					customCalled = true;
				},
			},
		});
		await commandOptions?.handler("bad", context);
		expect(notifications).toHaveLength(1);

		await commandOptions?.handler("", context);
		expect(commandName).toBe("usage");
		expect(customCalled).toBe(true);

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
		expect(printNotification).toMatchObject({ message: expect.any(String), type: "info" });
	});
});

function clientOptions(fetchImpl: typeof fetch): Parameters<typeof collectUsageSnapshot>[1] {
	return { fetchImpl, signal: undefined, now: NOW };
}

function loadOptions(refresh = false): Parameters<UsageService["load"]>[1] {
	return { refresh, signal: undefined };
}

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

function fixtureFetch(requests: CapturedRequest[] = []): typeof fetch {
	return async (input, request) => {
		if (request === undefined) throw new Error("Missing request options");
		const url = requestUrl(input);
		requests.push({ url, request });
		return fixtureResponse(url);
	};
}

function requestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : String(input);
}

function fixtureResponse(url: string): Response {
	if (url === "https://api.anthropic.com/api/oauth/usage") {
		return jsonResponse({
			five_hour: { utilization: 25, resets_at: "2026-07-27T05:00:00Z" },
			seven_day: { utilization: 50, resets_at: "2026-08-03T00:00:00Z" },
			limits: [{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 60,
				resets_at: "2026-08-03T00:00:00Z",
				scope: { model: { display_name: "Sonnet" } },
			}],
			extra_usage: { is_enabled: true, used_credits: 12.34, monthly_limit: 50, utilization: 24.68, currency: "USD" },
		});
	}
	if (url === "https://chatgpt.com/backend-api/wham/usage") {
		return jsonResponse({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: 1_785_153_600 },
				secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_after_seconds: 604_800, reset_at: 1_785_672_000 },
			},
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 3_600, reset_after_seconds: 1_800, reset_at: 1_785_151_800 } },
			}],
			rate_limit_reset_credits: { available_count: 2 },
			credits: { has_credits: true, unlimited: false, balance: "9" },
		});
	}
	if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
		return jsonResponse({
			available_count: 2,
			credits: [
				{
					id: "RateLimitResetCredit_1",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-07-12T00:00:00Z",
					expires_at: "2026-08-12T00:00:00Z",
				},
				{
					id: "RateLimitResetCredit_2",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-07-13T00:00:00Z",
					expires_at: "2026-08-13T00:00:00Z",
				},
			],
		});
	}
	if (url === "https://api.kimi.com/coding/v1/usages") {
		return jsonResponse({
			limits: [{
				window: { timeUnit: "TIME_UNIT_MINUTE", duration: 300 },
				detail: { used: "25", limit: "100", resetTime: "2026-07-27T05:00:00Z" },
			}],
			usage: { used: "4", limit: "8", resetTime: "2026-08-03T00:00:00Z" },
		});
	}
	if (url === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
		return jsonResponse({ config: {
			creditUsagePercent: 56,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-07-27T00:00:00Z",
				end: "2026-08-03T00:00:00Z",
			},
			used: { val: 250 },
			monthlyLimit: { val: 1000 },
			billingPeriodStart: "2026-07-01T00:00:00Z",
			billingPeriodEnd: "2026-08-01T00:00:00Z",
		} });
	}
	if (url === "https://cli-chat-proxy.grok.com/v1/settings") {
		return jsonResponse({ subscription_tier_display: "SuperGrok" });
	}
	throw new Error(`Unexpected test URL: ${url}`);
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
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
