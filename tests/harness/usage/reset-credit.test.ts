import type { AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { UsageContext } from "../../../src/harness/usage/client.ts";
import { UsageService } from "../../../src/harness/usage/service.ts";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
const context: UsageContext = { modelRegistry: { getProviderAuth: async (id) => id === "openai-codex" ? { source: "OAuth", auth: { apiKey: token } } : undefined } };
const options = { creditId: "credit-1", requestId: "b04ceaf7-45ef-4cea-93af-78acf5c56ddf", signal: undefined };
const loadOptions = { refresh: false, signal: undefined };
const json = (value: unknown) => new Response(JSON.stringify(value));
const usage = (count: number) => ({ plan_type: "pro", rate_limit_reset_credits: { available_count: count } });

function fixtureFetch(post: (request: RequestInit) => Promise<Response>, count = () => 2): typeof fetch {
	return async (input, request) => {
		const url = String(input);
		if (url.endsWith("/consume") && request) return post(request);
		if (url.endsWith("/usage")) return json(usage(count()));
		if (url.endsWith("/rate-limit-reset-credits")) return json({ available_count: count(), credits: Array.from({ length: count() }, (_, index) => ({
			id: `credit-${index + 1}`, status: "available", granted_at: "2026-10-01T00:00:00Z", expires_at: "2026-11-01T00:00:00Z",
		})) });
		throw new Error(`Unexpected URL: ${url}`);
	};
}

describe("Codex 重置卡", () => {
	it("提交指定卡片，兑换后重新读取用量", async () => {
		let count = 2;
		const post = vi.fn(async (request: RequestInit) => {
			expect(request.method).toBe("POST");
			expect(request.redirect).toBe("error");
			const headers = new Headers(request.headers);
			expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
			expect(headers.get("ChatGPT-Account-Id")).toBe("account-123");
			expect(headers.get("Content-Type")).toBe("application/json");
			expect(JSON.parse(String(request.body))).toEqual({ credit_id: "credit-2", redeem_request_id: options.requestId });
			count = 1;
			return json({ code: "reset", windows_reset: 2 });
		});
		const service = new UsageService({ fetchImpl: fixtureFetch(post, () => count) });
		const before = await service.load(context, loadOptions);
		expect(before.providers[0]).toMatchObject({ resetCredits: { availableCount: 2, credits: [{ id: "credit-1" }, { id: "credit-2" }] } });
		expect(await service.consumeCodexCredit(context, { ...options, creditId: "credit-2" })).toBe("reset");
		expect((await service.load(context, loadOptions)).providers[0]).toMatchObject({ resetCredits: { availableCount: 1, credits: [{ id: "credit-1" }] } });
		expect(post).toHaveBeenCalledTimes(1);
	});

	it("没有 OAuth 凭据时不发送兑换请求", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const service = new UsageService({ fetchImpl });
		for (const auth of [undefined, { source: "API key", auth: { apiKey: "secret" } }] satisfies (AuthResult | undefined)[]) {
			await expect(service.consumeCodexCredit({ modelRegistry: { getProviderAuth: async () => auth } }, options)).rejects.toMatchObject({ code: "auth" });
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("网络结果不明时不自动重试，清理缓存并允许手动确认结果", async () => {
		const post = vi.fn(async (_request: RequestInit): Promise<Response> => { throw new Error(`secret: ${token}`); });
		const service = new UsageService({ fetchImpl: fixtureFetch(post) });
		const before = await service.load(context, loadOptions);
		await expect(service.consumeCodexCredit(context, options)).rejects.toMatchObject({ code: "request_failed", message: "request_failed" });
		expect(post).toHaveBeenCalledTimes(1);
		expect(await service.load(context, loadOptions)).not.toBe(before);
		post.mockImplementationOnce(async () => json({ code: "already_redeemed" }));
		expect(await service.consumeCodexCredit(context, options)).toBe("already_redeemed");
	});

	it("同一服务拒绝并发兑换，完成后解除锁定", async () => {
		const gate = Promise.withResolvers<Response>();
		const post = vi.fn(async () => gate.promise);
		const service = new UsageService({ fetchImpl: fixtureFetch(post) });
		const first = service.consumeCodexCredit(context, options);
		await expect(service.consumeCodexCredit(context, { ...options, creditId: "credit-2" })).rejects.toMatchObject({ code: "busy" });
		gate.resolve(json({ code: "reset" }));
		await first;
		expect(post).toHaveBeenCalledTimes(1);
		post.mockImplementationOnce(async () => json({ code: "no_credit" }));
		expect(await service.consumeCodexCredit(context, { ...options, creditId: "credit-2", requestId: "next-request" })).toBe("no_credit");
	});

	it("兑换后不会合并或缓存兑换前尚未完成的查询", async () => {
		const stale = Promise.withResolvers<Response>();
		let reads = 0;
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/consume")) return json({ code: "reset" });
			if (url.endsWith("/usage")) return ++reads === 1 ? stale.promise : json(usage(1));
			return json({});
		};
		const service = new UsageService({ fetchImpl });
		const oldLoad = service.load(context, loadOptions);
		await vi.waitFor(() => expect(reads).toBe(1));
		await service.consumeCodexCredit(context, options);
		const fresh = await service.load(context, loadOptions);
		expect(fresh.providers[0]).toMatchObject({ resetCredits: { availableCount: 1 } });
		stale.resolve(json(usage(2)));
		await oldLoad;
		expect(await service.load(context, loadOptions)).toBe(fresh);
	});

	it("服务商返回未知兑换结果时不视为成功", async () => {
		const service = new UsageService({ fetchImpl: fixtureFetch(async () => json({ code: "unknown" })) });
		await expect(service.consumeCodexCredit(context, options)).rejects.toMatchObject({ code: "invalid_response" });
	});

	it.each(["aborted", "timeout"] as const)("兑换请求 %s 后解除锁定且不自动重试", async (code) => {
		const controller = new AbortController();
		const timeout = code === "timeout" ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal) : undefined;
		const post = vi.fn(async (request: RequestInit) => new Promise<Response>((_resolve, reject) => {
			const signal = request.signal;
			if (!signal) throw new Error("Missing signal");
			if (signal.aborted) reject(new Error("cancelled"));
			else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		}));
		const service = new UsageService({ fetchImpl: fixtureFetch(post) });
		try {
			const result = service.consumeCodexCredit(context, { ...options, signal: code === "aborted" ? controller.signal : undefined });
			const rejected = expect(result).rejects.toMatchObject({ code });
			await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
			controller.abort();
			await rejected;
			expect(post).toHaveBeenCalledTimes(1);
		} finally { timeout?.mockRestore(); }
		post.mockImplementationOnce(async () => json({ code: "already_redeemed" }));
		expect(await service.consumeCodexCredit(context, options)).toBe("already_redeemed");
	});
});
