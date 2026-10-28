import { expect, it, vi } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { GuiEvent } from "../../../../src/gui/shared/protocol/events.ts";
import { readSnapshot } from "../read-snapshot.ts";

export function usageCreditTests(context: () => { host: GuiClient; events: GuiEvent[] }): void {
	it("GUI 重置卡消费指定卡片并刷新共享缓存，不写入会话或暴露凭据", async () => {
		const { host, events } = context();
		const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url")}.signature`;
		const auth = vi.spyOn(host.runtime.session.extensionRunner.createCommandContext().modelRegistry, "getProviderAuth").mockImplementation(async (provider) => provider === "openai-codex" ? { source: "OAuth", auth: { apiKey: token } } : undefined);
		let consumed = false;
		const posts: unknown[] = [];
		const json = (value: unknown) => new Response(JSON.stringify(value));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, request) => {
			const url = String(input);
			if (url.endsWith("/consume")) {
				posts.push(JSON.parse(String(request?.body)));
				consumed = true;
				return json({ code: "reset", windows_reset: 1 });
			}
			if (url.endsWith("/wham/usage")) return json({ plan_type: "pro", rate_limit_reset_credits: { available_count: consumed ? 1 : 2 } });
			if (url.endsWith("/rate-limit-reset-credits")) return json({ available_count: consumed ? 1 : 2, credits: (consumed ? ["credit-1"] : ["credit-1", "credit-2"]).map((id) => ({
				id, status: "available", granted_at: "2026-10-01T00:00:00Z", expires_at: "2026-11-01T00:00:00Z",
			})) });
			throw new Error(`Unexpected URL: ${url}`);
		});
		try {
			const before = readSnapshot(host);
			await host.dispatch({ action: "view", view: "usage" });
			expect(await host.dispatch({ action: "consumeCodexCredit", creditId: "credit-2", requestId: "b04ceaf7-45ef-4cea-93af-78acf5c56ddf" })).toEqual({ outcome: "reset", refreshed: true });
			expect(posts).toEqual([{ credit_id: "credit-2", redeem_request_id: "b04ceaf7-45ef-4cea-93af-78acf5c56ddf" }]);
			expect(events.filter((event) => event.type === "panel").at(-1)).toMatchObject({ panel: {
				kind: "usage", value: { providers: [{ id: "openai-codex", resetCredits: { availableCount: 1 } }] },
			} });
			const calls = fetchMock.mock.calls.length;
			await host.dispatch({ action: "view", view: "usage" });
			expect(fetchMock).toHaveBeenCalledTimes(calls);
			expect(readSnapshot(host).history).toEqual(before.history);
			expect(readSnapshot(host).entries).toEqual(before.entries);
			expect(JSON.stringify(events)).not.toContain(token);
		} finally { auth.mockRestore(); fetchMock.mockRestore(); }
	});

	it("兑换已确认后取消刷新，仍返回明确兑换结果且不替换当前面板", async () => {
		const { host, events } = context();
		const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url")}.signature`;
		const auth = vi.spyOn(host.runtime.session.extensionRunner.createCommandContext().modelRegistry, "getProviderAuth").mockImplementation(async (provider) => provider === "openai-codex" ? { source: "OAuth", auth: { apiKey: token } } : undefined);
		const refreshing = Promise.withResolvers<void>();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, request) => {
			if (String(input).endsWith("/consume")) return new Response(JSON.stringify({ code: "nothing_to_reset" }));
			if (!String(input).endsWith("/usage")) return new Response("{}");
			const signal = request?.signal;
			if (!signal) throw new Error("缺少取消信号");
			refreshing.resolve();
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
			});
		});
		try {
			const panels = events.filter((event) => event.type === "panel");
			const consumed = host.dispatch({ action: "consumeCodexCredit", creditId: "credit-1", requestId: "confirmed" });
			await refreshing.promise;
			await host.dispatch({ action: "abort" });
			expect(await consumed).toEqual({ outcome: "nothing_to_reset", refreshed: false });
			expect(events.filter((event) => event.type === "panel")).toEqual(panels);
			expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/consume"))).toHaveLength(1);
		} finally { auth.mockRestore(); fetchMock.mockRestore(); }
	});

	it("GUI 重置卡失败只返回脱敏提示，不发送第二次兑换", async () => {
		const { host } = context();
		const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url")}.signature`;
		const auth = vi.spyOn(host.runtime.session.extensionRunner.createCommandContext().modelRegistry, "getProviderAuth").mockResolvedValue({ source: "OAuth", auth: { apiKey: token } });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private upstream response", { status: 503 }));
		try {
			await expect(host.dispatch({ action: "consumeCodexCredit", creditId: "credit-1", requestId: "retry-1" }))
				.rejects.toThrow("重置请求返回 HTTP 503。请刷新用量后重试同一张卡。");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally { auth.mockRestore(); fetchMock.mockRestore(); }
	});
}
