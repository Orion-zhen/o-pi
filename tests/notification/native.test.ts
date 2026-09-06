import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn<(
	notification: { title: string; message: string },
	callback: (error: Error | null, response: string) => void,
) => unknown>();

beforeEach(() => {
	vi.resetModules();
	notify.mockReset();
	vi.doMock("node-notifier", () => ({ default: { notify } }));
});
afterEach(() => vi.doUnmock("node-notifier"));

describe("native notification", () => {
	it("通过默认后端发送固定的 o-pi 等待消息", async () => {
		notify.mockImplementation((_notification, callback) => callback(null, "sent"));
		const { notifyWaiting } = await import("../../src/notification/native.js");
		await notifyWaiting();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			{ title: "o-pi", message: "o-pi is waiting for you." }, expect.any(Function),
		);
	});

	it("加载后端失败时静默降级", async () => {
		vi.doMock("node-notifier", () => { throw new Error("load failed"); });
		const { notifyWaiting } = await import("../../src/notification/native.js");
		await expect(notifyWaiting()).resolves.toBeUndefined();
		expect(notify).not.toHaveBeenCalled();
	});

	it("后端发送失败时静默降级", async () => {
		notify.mockImplementation(() => { throw new Error("send failed"); });
		const { notifyWaiting } = await import("../../src/notification/native.js");
		await expect(notifyWaiting()).resolves.toBeUndefined();
	});
});
