import { describe, expect, it, vi } from "vitest";
import { collectUsageSnapshot, type UsageContext } from "../../../src/harness/usage/client.ts";
import { renderUsage } from "../../../src/harness/usage/presentation/render.ts";

const KEY = "deepseek-test-secret";
const balanceInfo = { currency: "CNY", total_balance: "12.3456", granted_balance: "2.3456", topped_up_balance: "10.0000" };
const options = { signal: undefined, now: new Date("2026-10-19T00:00:00Z") };

function context(): UsageContext {
	return { modelRegistry: { getProviderAuth: async (id) => id === "deepseek"
		? { source: "DEEPSEEK_API_KEY", auth: { apiKey: KEY } }
		: undefined } };
}

function response(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("DeepSeek 余额", () => {
	it("复用已解析的 API key 查询官方余额，保留币种和金额精度", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ is_available: true, balance_infos: [balanceInfo, {
			currency: "USD", total_balance: "0.001234", granted_balance: "0", topped_up_balance: "0.001234",
		}] }));
		const snapshot = await collectUsageSnapshot(context(), { ...options, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://api.deepseek.com/user/balance", expect.objectContaining({
			headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" }, redirect: "error", signal: expect.any(AbortSignal),
		}));
		expect(snapshot.providers.find(({ id }) => id === "deepseek")).toEqual({
			id: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", isAvailable: true,
			balances: [
				{ currency: "CNY", total: "12.3456", granted: "2.3456", toppedUp: "10.0000" },
				{ currency: "USD", total: "0.001234", granted: "0", toppedUp: "0.001234" },
			],
		});
		const text = renderUsage(snapshot, 80).join("\n");
		expect(text).toContain("DeepSeek");
		expect(text).toContain("API balance");
		expect(text).toContain("CNY 12.3456");
		expect(text).toContain("USD 0.001234");
		expect(text).not.toMatch(/window|plan unknown/);
		expect(JSON.stringify(snapshot)).not.toContain(KEY);
	});

	it("余额不足仍是成功查询，不伪装成请求失败", async () => {
		const snapshot = await collectUsageSnapshot(context(), { ...options, fetchImpl: async () => response({
			is_available: false, balance_infos: [{ ...balanceInfo, total_balance: "-0.0001", topped_up_balance: "-2.3457" }],
		}) });
		expect(snapshot.providers.find(({ id }) => id === "deepseek")).toMatchObject({ status: "ok", isAvailable: false });
		expect(renderUsage(snapshot, 80).join("\n")).toContain("Insufficient balance");
	});

	it("余额响应缺少明细时显示响应格式错误", async () => {
		const snapshot = await collectUsageSnapshot(context(), { ...options, fetchImpl: async () => response({ is_available: true }) });
		expect(snapshot.providers.find(({ id }) => id === "deepseek")).toMatchObject({ status: "error", error: { code: "invalid_response" } });
	});

	it("认证失败不泄露响应正文或凭据", async () => {
		const snapshot = await collectUsageSnapshot(context(), { ...options, fetchImpl: async () => new Response(`secret-body ${KEY}`, { status: 401 }) });
		expect(snapshot.providers.find(({ id }) => id === "deepseek")).toMatchObject({ status: "error", error: { code: "http", httpStatus: 401 } });
		expect(renderUsage(snapshot, 80).join("\n")).not.toMatch(/secret-body|deepseek-test-secret/);
	});
});
