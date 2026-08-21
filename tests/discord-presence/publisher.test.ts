import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresencePublisher } from "../../src/discord-presence/publisher.js";
import type { DiscordActivityPayload } from "../../src/discord-presence/types.js";
import { FakeTransport } from "./fixtures.js";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Discord presence publisher", () => {
	it("首个状态立即发送，后续状态合并、去重，并在失败后重试最新值", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		const idle = { details: "Idle", instance: false } as const;
		const reading = { details: "Reading a.ts", instance: false } as const;
		const thinking = { details: "Thinking", instance: false } as const;

		publisher.request(idle);
		await vi.waitFor(() => expect(transport.activities).toEqual([idle]));
		publisher.request(idle);
		expect(transport.activities).toEqual([idle]);

		publisher.request(reading);
		publisher.request(thinking);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities).toEqual([idle, thinking]);

		transport.failSetCount = 1;
		publisher.request(reading);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(transport.activities).toEqual([idle, thinking]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities).toEqual([idle, thinking, reading]);

		publisher.request(thinking);
		publisher.stop();
		publisher.stop();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities).toEqual([idle, thinking, reading]);
	});

	it("使用配置的最小更新间隔", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 5_000, 30_000);
		publisher.request({ details: "Idle", instance: false });
		expect(transport.activities).toHaveLength(1);
		await Promise.resolve();
		publisher.request({ details: "Thinking", instance: false });
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Thinking" });
		publisher.stop();
	});

	it("运行时更新全局发送间隔时重新安排等待中的最新状态", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		publisher.request({ details: "Initial", instance: false });
		expect(transport.activities).toHaveLength(1);
		await Promise.resolve();
		await Promise.resolve();
		publisher.request({ details: "Updated", instance: false });
		publisher.configure(5_000, 30_000);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Updated" });
		publisher.stop();
	});

	it("使用配置的失败重试间隔", async () => {
		const transport = new FakeTransport();
		transport.failSetCount = 1;
		const publisher = new PresencePublisher(transport, 5_000, 7_000);
		publisher.request({ details: "Idle", instance: false });
		expect(transport.failSetCount).toBe(0);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(6_999);
		expect(transport.activities).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Idle" });
		publisher.stop();
	});

	it("断线后即使没有新事件也会重试最后状态", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		publisher.request({ details: "Thinking", instance: false });
		expect(transport.activities).toHaveLength(1);
		await Promise.resolve();
		await Promise.resolve();
		transport.emitStatus("disconnected");
		await vi.advanceTimersByTimeAsync(29_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities).toHaveLength(2);
		publisher.stop();
	});

	it("clear 后的新状态使用更新间隔，而不是失败重试间隔", async () => {
		let releaseFirstSend: (() => void) | undefined;
		class BlockingTransport extends FakeTransport {
			private first = true;
			override async setActivity(activity: DiscordActivityPayload): Promise<void> {
				if (this.first) {
					this.first = false;
					await new Promise<void>((resolve) => {
						releaseFirstSend = resolve;
					});
				}
				await super.setActivity(activity);
			}
		}
		const transport = new BlockingTransport();
		const publisher = new PresencePublisher(transport, 5_000, 30_000);
		publisher.request({ details: "Old", instance: false });
		publisher.clear();
		publisher.request({ details: "New", instance: false });
		releaseFirstSend?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)).toMatchObject({ details: "New" });
		publisher.stop();
	});

	it("断线通知会使等待中的相同状态重新进入发送队列", async () => {
		const transport = new FakeTransport();
		const publisher = new PresencePublisher(transport, 15_000, 30_000);
		const activity = { details: "Thinking", instance: false } as const;
		publisher.request(activity);
		await vi.waitFor(() => expect(transport.activities).toHaveLength(1));
		publisher.request({ details: "Reading", instance: false });
		transport.emitStatus("disconnected");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transport.activities.at(-1)).toMatchObject({ details: "Reading" });
		publisher.stop();
	});
});

