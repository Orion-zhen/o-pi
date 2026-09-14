import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordCoordinatorOutput } from "../../../src/harness/discord-presence/output.js";
import * as rpc from "../../../src/harness/discord-presence/transport.js";
import type { DiscordActivityPayload } from "../../../src/harness/discord-presence/types.js";
import { coordinatedConfig, FakeTransport } from "./fixtures.js";

const outputs: DiscordCoordinatorOutput[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(rpc, "createDiscordRpcTransport");
});
afterEach(async () => {
	await Promise.all(outputs.splice(0).map((output) => output.dispose()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup(transport = new FakeTransport()) {
	const transports: FakeTransport[] = [];
	vi.mocked(rpc.createDiscordRpcTransport).mockImplementation(async () => {
		const next = transports.length === 0 ? transport : new FakeTransport();
		transports.push(next);
		return next;
	});
	const output = new DiscordCoordinatorOutput();
	outputs.push(output);
	const config = coordinatedConfig();
	return {
		output, transport, transports, config,
		show(details: string) { output.show({ config: { ...config }, activity: { details, instance: false } }); },
	};
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Discord presence 输出", () => {
	it("回到已发送状态时取消中间的过期状态", async () => {
		const { transport, show } = setup();
		show("Idle");
		await flush();
		show("Reading");
		show("Idle");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(transport.activities).toEqual([{ details: "Idle", instance: false }]);
	});

	it("首个状态立即发送，后续只发送最新状态并去重", async () => {
		const { transport, show } = setup();
		show("Idle");
		await flush();
		show("Reading");
		show("Thinking");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)?.details).toBe("Thinking");
		show("Thinking");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(transport.activities).toHaveLength(2);
	});

	it("发送期间收到的新状态不会丢失", async () => {
		let release = () => {};
		class BlockingTransport extends FakeTransport {
			override async setActivity(activity: DiscordActivityPayload) {
				await new Promise<void>((resolve) => { release = resolve; });
				await super.setActivity(activity);
			}
		}
		const { transport, show } = setup(new BlockingTransport());
		show("Idle");
		await flush();
		show("Reading");
		show("Idle");
		release();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(transport.activities).toEqual([{ details: "Idle", instance: false }]);
	});

	it("修改配置后重新安排等待中的目标", async () => {
		const { transport, config, show } = setup();
		config.updateIntervalMs = 15_000;
		show("Initial");
		await flush();
		show("Updated");
		config.updateIntervalMs = 5_000;
		show("Updated");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)?.details).toBe("Updated");
	});

	it("发送失败后按重试间隔发送最新值，新事件不会提前重试", async () => {
		const { transport, config, show } = setup();
		config.retryIntervalMs = 7_000;
		transport.failSetCount = 1;
		show("Initial");
		await flush();
		show("Recovered");
		await vi.advanceTimersByTimeAsync(6_999);
		expect(transport.activities).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities.at(-1)?.details).toBe("Recovered");
	});

	it("断线后没有新事件也会恢复最后状态", async () => {
		const { transport, show } = setup();
		show("Thinking");
		await flush();
		transport.emitStatus("disconnected");
		await vi.advanceTimersByTimeAsync(29_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.activities).toHaveLength(2);
	});

	it("隐藏后可以恢复展示，销毁时撤销等待并只关闭一次连接", async () => {
		const { output, transport, transports, show } = setup();
		show("Initial");
		await flush();
		await output.hide();
		show("New");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(transports[1]?.activities.at(-1)?.details).toBe("New");
		show("Cancelled");
		await output.dispose();
		await output.dispose();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(transports.flatMap((current) => current.activities)).toHaveLength(2);
		expect(transport.closeCount).toBe(1);
		expect(transports[1]?.closeCount).toBe(1);
		expect(output.getStatus()).toBe("disabled");
	});

	it("发送期间隐藏再展示，新状态使用更新间隔", async () => {
		let release = () => {};
		class BlockingTransport extends FakeTransport {
			private first = true;
			override async setActivity(activity: DiscordActivityPayload) {
				if (this.first) {
					this.first = false;
					await new Promise<void>((resolve) => { release = resolve; });
				}
				await super.setActivity(activity);
			}
		}
		const { output, transport, transports, show } = setup(new BlockingTransport());
		show("Old");
		await flush();
		const hidden = output.hide();
		show("New");
		release();
		await hidden;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(transport.activities).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(transports[1]?.activities.at(-1)?.details).toBe("New");
	});

	it("应用也是去重目标的一部分，切换时清理旧连接", async () => {
		const a = new FakeTransport();
		const b = new FakeTransport();
		vi.mocked(rpc.createDiscordRpcTransport).mockImplementation(async (id) =>
			id === coordinatedConfig().applicationId ? a : b);
		const output = new DiscordCoordinatorOutput();
		outputs.push(output);
		const activity = { details: "Same", instance: false } as const;
		output.show({ config: coordinatedConfig(), activity });
		await flush();
		output.show({ config: coordinatedConfig("223456789012345678"), activity });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(b.activities).toEqual([activity]);
		expect(a).toMatchObject({ clearCount: 1, closeCount: 1 });
	});

	it("同一应用连接就绪后直接发送最新内容，不等待额外间隔", async () => {
		const transport = new FakeTransport();
		let release = () => {};
		const creating = new Promise<FakeTransport>((resolve) => { release = () => resolve(transport); });
		vi.mocked(rpc.createDiscordRpcTransport).mockReturnValue(creating);
		const output = new DiscordCoordinatorOutput();
		outputs.push(output);
		output.show({ config: coordinatedConfig(), activity: { details: "Old", instance: false } });
		await flush();
		output.show({ config: coordinatedConfig(), activity: { details: "Latest", instance: false } });
		release();
		await flush();
		expect(transport.activities).toEqual([{ details: "Latest", instance: false }]);
	});

	it("异步创建连接期间切换应用，不把旧内容发送给新应用", async () => {
		const a = new FakeTransport();
		const b = new FakeTransport();
		let release = () => {};
		const creating = new Promise<FakeTransport>((resolve) => { release = () => resolve(a); });
		const factory = vi.mocked(rpc.createDiscordRpcTransport).mockImplementation((id) =>
			id === coordinatedConfig().applicationId ? creating : Promise.resolve(b));
		const output = new DiscordCoordinatorOutput();
		outputs.push(output);
		output.show({ config: coordinatedConfig(), activity: { details: "A", instance: false } });
		await flush();
		expect(factory).toHaveBeenCalled();
		output.show({ config: coordinatedConfig("223456789012345678"), activity: { details: "B", instance: false } });
		release();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(a.activities).toEqual([]);
		expect(b.activities).toEqual([{ details: "B", instance: false }]);
		expect(a.closeCount).toBe(1);
	});
});
