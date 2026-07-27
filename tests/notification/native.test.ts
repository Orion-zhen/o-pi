import { describe, expect, it, vi } from "vitest";
import { notifyWaiting } from "../../src/notification/native.js";

const backend = vi.hoisted(() => ({
	notify: vi.fn<(
		notification: { title: string; message: string },
		callback: (error: Error | null, response: string) => void,
	) => unknown>(),
}));

vi.mock("node-notifier", () => ({ default: { notify: backend.notify } }));

describe("native notification", () => {
	it("通过默认后端发送固定的 o-pi 等待消息", async () => {
		backend.notify.mockImplementation((_notification, callback) => {
			callback(null, "sent");
		});

		await notifyWaiting();

		expect(backend.notify).toHaveBeenCalledOnce();
		expect(backend.notify).toHaveBeenCalledWith(
			{ title: "o-pi", message: "o-pi is waiting for you." },
			expect.any(Function),
		);
	});

	it.each([
		["加载失败", async () => {
			throw new Error("load failed");
		}],
		["发送失败", async () => ({
			notify() {
				throw new Error("send failed");
			},
		})],
	] as const)("%s 时静默降级", async (_name, loadNotifier) => {
		await expect(notifyWaiting(loadNotifier)).resolves.toBeUndefined();
	});
});
