import { beforeEach, describe, expect, it, vi } from "vitest";

const discordMock = vi.hoisted(() => {
	const instances: MockClient[] = [];
	let nextLoginError: Error | undefined;
	class MockClient {
		isConnected = false;
		readonly activities: unknown[] = [];
		clearCount = 0;
		destroyCount = 0;
		failSet = false;
		private readonly listeners = new Map<string, Array<() => void>>();
		readonly user = {
			setActivity: async (activity: unknown) => {
				if (this.failSet) throw new Error("set failed");
				this.activities.push(activity);
			},
			clearActivity: async () => {
				this.clearCount += 1;
			},
		};
		constructor(readonly options: unknown) {
			instances.push(this);
		}
		on(event: string, listener: () => void): this {
			const current = this.listeners.get(event) ?? [];
			current.push(listener);
			this.listeners.set(event, current);
			return this;
		}
		async login(): Promise<void> {
			if (nextLoginError !== undefined) {
				const error = nextLoginError;
				nextLoginError = undefined;
				throw error;
			}
			this.isConnected = true;
		}
		async destroy(): Promise<void> {
			this.destroyCount += 1;
			this.isConnected = false;
		}
		disconnect(): void {
			this.isConnected = false;
			for (const listener of this.listeners.get("disconnected") ?? []) listener();
		}
	}
	return {
		MockClient,
		instances,
		failNextLogin(error: Error) {
			nextLoginError = error;
		},
	};
});

vi.mock("@xhayper/discord-rpc", () => ({ Client: discordMock.MockClient }));

import { createDiscordRpcTransport } from "../../../src/harness/discord-presence/transport.js";

beforeEach(() => {
	discordMock.instances.length = 0;
});

describe("@xhayper Discord transport", () => {
	it("连接、设置、清除、断线和关闭均映射为稳定 transport 接口", async () => {
		const transport = await createDiscordRpcTransport("123456789012345678");
		const statuses: string[] = [];
		const unsubscribe = transport.onStatus((status) => statuses.push(status));
		await transport.setActivity({ details: "Thinking", instance: false });
		const client = discordMock.instances[0];
		expect(client?.options).toEqual({ clientId: "123456789012345678", transport: { type: "ipc" } });
		expect(client?.activities).toEqual([{ details: "Thinking", instance: false }]);
		expect(transport.getStatus()).toBe("connected");
		await transport.clearActivity();
		expect(client?.clearCount).toBe(1);

		client?.disconnect();
		expect(transport.getStatus()).toBe("disconnected");
		unsubscribe();
		await transport.close();
		expect(transport.getStatus()).toBe("disabled");
		expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
	});

	it("连接失败后允许使用新 client 重试", async () => {
		discordMock.failNextLogin(new Error("Discord is not running"));
		const transport = await createDiscordRpcTransport("123456789012345678");
		await expect(transport.setActivity({ details: "Initial", instance: false })).rejects.toThrow("not running");
		expect(transport.getStatus()).toBe("disconnected");
		await transport.setActivity({ details: "Recovered", instance: false });
		expect(discordMock.instances).toHaveLength(2);
		await transport.close();
	});

	it("活动发送无响应时超时并丢弃连接，后续发送能够恢复", async () => {
		vi.useFakeTimers();
		const transport = await createDiscordRpcTransport("123456789012345678");
		try {
			await transport.setActivity({ details: "Initial", instance: false });
			const client = discordMock.instances[0];
			if (client === undefined) throw new Error("mock client missing");
			vi.spyOn(client.user, "setActivity").mockImplementation(() => new Promise<void>(() => {}));
			const failed = expect(transport.setActivity({ details: "Blocked", instance: false })).rejects.toThrow("timed out");
			await vi.advanceTimersByTimeAsync(2_000);
			await failed;
			expect(client.destroyCount).toBe(1);
			await transport.setActivity({ details: "Recovered", instance: false });
			expect(discordMock.instances[1]?.activities).toEqual([{ details: "Recovered", instance: false }]);
		} finally {
			await transport.close();
			vi.useRealTimers();
		}
	});

	it("发送失败会丢弃 client，下一次发送重新连接", async () => {
		const transport = await createDiscordRpcTransport("123456789012345678");
		await transport.setActivity({ details: "Initial", instance: false });
		const first = discordMock.instances[0];
		if (first === undefined) throw new Error("mock client missing");
		first.failSet = true;
		await expect(transport.setActivity({ details: "Failure", instance: false })).rejects.toThrow("set failed");
		expect(first.destroyCount).toBe(1);
		await transport.setActivity({ details: "Recovered", instance: false });
		expect(discordMock.instances).toHaveLength(2);
		await transport.close();
	});
});
