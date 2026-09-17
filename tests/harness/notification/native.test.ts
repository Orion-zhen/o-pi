import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preserveEnv } from "../../helpers/lifecycle.ts";

preserveEnv("NODE_ENV");

const notify = vi.fn<(
	notification: { title: string; message: string },
	callback: (error: Error | null, response: string) => void,
) => unknown>();

beforeEach(() => {
	process.env.NODE_ENV = "production";
	vi.resetModules();
	notify.mockReset();
	vi.doMock("node-notifier", () => ({ default: { notify } }));
});
afterEach(() => vi.doUnmock("node-notifier"));

describe("native notification", () => {
	it("测试环境不加载或调用通知后端", async () => {
		process.env.NODE_ENV = "test";
		const load = vi.fn(() => ({ default: { notify } }));
		vi.doMock("node-notifier", load);
		const { notifyWaiting } = await import("../../../src/harness/notification/native.ts");
		await notifyWaiting();
		expect(load).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("通过默认后端发送固定的 opi 等待消息", async () => {
		notify.mockImplementation((_notification, callback) => callback(null, "sent"));
		const { notifyWaiting } = await import("../../../src/harness/notification/native.ts");
		await notifyWaiting();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			{ title: "opi", message: "opi is waiting for you." }, expect.any(Function),
		);
	});

	it("加载后端失败时静默降级", async () => {
		vi.doMock("node-notifier", () => { throw new Error("load failed"); });
		const { notifyWaiting } = await import("../../../src/harness/notification/native.ts");
		await expect(notifyWaiting()).resolves.toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("后端发送失败时静默降级", async () => {
		notify.mockImplementation(() => { throw new Error("send failed"); });
		const { notifyWaiting } = await import("../../../src/harness/notification/native.ts");
		await expect(notifyWaiting()).resolves.toBeUndefined();
	});
});
