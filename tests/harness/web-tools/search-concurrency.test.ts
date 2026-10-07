import { describe, expect, it, vi } from "vitest";

import { deferredVoid } from "../../helpers/async.ts";
import { httpResponse } from "../../helpers/http.ts";
import { useWebSearch } from "./search-fixture.ts";

const fixture = useWebSearch();
const params = { query: "pi docs" };
const response = () => httpResponse(200, JSON.stringify({ grounding: { generic: [{ title: "Pi", url: "https://example.com/pi" }] } }));

describe("并发搜索共享请求", () => {
	it.each(["first", "second", "before-joining"] as const)("取消 %s 调用只结束自己的等待，其他调用继续使用原请求", async (cancelled) => {
		const started = deferredVoid();
		const joined = deferredVoid();
		const release = deferredVoid();
		fixture.fetchImpl.mockImplementation(async (_url, init) => {
			started.resolve();
			await release.promise;
			init.signal.throwIfAborted();
			return response();
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const firstUpdate = vi.fn();
		const secondUpdate = vi.fn(() => joined.resolve());
		const firstSettled = vi.fn();
		const secondSettled = vi.fn();
		const first = fixture.runtime.search(params, { toolCallId: "first", signal: firstController.signal, onUpdate: firstUpdate })
			.then((result) => { firstSettled(result); return result; });
		await started.promise;
		if (cancelled === "before-joining") secondController.abort();
		const second = fixture.runtime.search(params, { toolCallId: "second", signal: secondController.signal, onUpdate: secondUpdate })
			.then((result) => { secondSettled(result); return result; });
		if (cancelled !== "before-joining") await joined.promise;
		const cancelledUpdate = cancelled === "first" ? firstUpdate : secondUpdate;
		try {
			if (cancelled === "first") firstController.abort();
			else secondController.abort();
			await vi.waitFor(() => expect(cancelled === "first" ? firstSettled : secondSettled).toHaveBeenCalledWith(
				expect.objectContaining({ details: expect.objectContaining({ error: { code: "ABORTED", message: "websearch request was aborted." } }) }),
			));
			expect(fixture.fetchImpl.mock.calls[0]?.[1].signal.aborted).toBe(false);
		} finally {
			release.resolve();
		}
		const updatesAtCancellation = cancelledUpdate.mock.calls.length;
		const results = await Promise.all([first, second]);
		expect(results[cancelled === "first" ? 1 : 0]?.details.status).toBe("success");
		expect(cancelledUpdate).toHaveBeenCalledTimes(updatesAtCancellation);
		expect(cancelled === "first" ? secondUpdate : firstUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ details: { status: "progress", phase: "parsing" } }),
		);
		expect(fixture.fetchImpl).toHaveBeenCalledOnce();
	});

	it("全部取消后立即重新搜索，不复用取消的请求，重试中的重复调用仍合并", async () => {
		const oldStarted = deferredVoid();
		const joined = deferredVoid();
		const oldCleanup = deferredVoid();
		const releaseNew = deferredVoid();
		fixture.config.websearch.primary_providers = ["brave_api", "exa_api", "tavily", "exa_mcp"];
		Object.assign(fixture.config.websearch.exa_api, { enabled: true, api_key: "exa-key" });
		fixture.fetchImpl.mockImplementationOnce(async (_url, init) => {
			oldStarted.resolve();
			await oldCleanup.promise;
			init.signal.throwIfAborted();
			return response();
		}).mockImplementation(async () => {
			await releaseNew.promise;
			return response();
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = fixture.runtime.search(params, { toolCallId: "first", signal: firstController.signal });
		await oldStarted.promise;
		const second = fixture.runtime.search(params, { toolCallId: "second", signal: secondController.signal, onUpdate: () => joined.resolve() });
		await joined.promise;
		firstController.abort();
		secondController.abort();
		try {
			expect(fixture.fetchImpl.mock.calls[0]?.[1].signal.aborted).toBe(true);
			const retried = fixture.runtime.search(params, { toolCallId: "retry" });
			await vi.waitFor(() => expect(fixture.fetchImpl).toHaveBeenCalledTimes(2));
			oldCleanup.resolve();
			await Promise.all([first, second]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const repeatedJoined = deferredVoid();
			const repeated = fixture.runtime.search(params, { toolCallId: "repeated-retry", onUpdate: () => repeatedJoined.resolve() });
			await repeatedJoined.promise;
			releaseNew.resolve();
			const results = await Promise.all([retried, repeated]);
			expect(results.every((result) => result.details.status === "success")).toBe(true);
			expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
			expect(fixture.fetchImpl.mock.calls.every(([url]) => url.hostname === "api.search.brave.com")).toBe(true);
		} finally {
			oldCleanup.resolve();
			releaseNew.resolve();
		}
	});

	it("取消搜索后关闭运行时，仍等待共享请求的传输清理", async () => {
		const started = deferredVoid();
		const cleanup = deferredVoid();
		fixture.fetchImpl.mockImplementation(async (_url, init) => {
			started.resolve();
			await cleanup.promise;
			init.signal.throwIfAborted();
			return response();
		});
		const controller = new AbortController();
		const settled = vi.fn();
		const pending = fixture.runtime.search(params, { toolCallId: "cancel-then-close", signal: controller.signal }).then(settled);
		await started.promise;
		controller.abort();
		try {
			await vi.waitFor(() => expect(settled).toHaveBeenCalled());
			const closed = vi.fn();
			const closing = fixture.runtime.close().then(closed);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).not.toHaveBeenCalled();
			cleanup.resolve();
			await closing;
			expect(closed).toHaveBeenCalledOnce();
		} finally {
			cleanup.resolve();
			await pending;
		}
	});
});
