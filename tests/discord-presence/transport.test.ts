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

import { SwitchingDiscordTransport } from "../../src/discord-presence/switching-transport.js";
import { createDiscordRpcTransport } from "../../src/discord-presence/transport.js";
import { FakeTransport } from "./fixtures.js";

beforeEach(() => {
	discordMock.instances.length = 0;
});

describe("Discord Application 切换 transport", () => {
	it("切换 Application 时清除旧连接，并只向当前连接发送", async () => {
		const transports: FakeTransport[] = [];
		const applicationIds: string[] = [];
		const switching = new SwitchingDiscordTransport(async (applicationId) => {
			applicationIds.push(applicationId);
			const transport = new FakeTransport();
			transports.push(transport);
			return transport;
		});
		switching.selectApplication("123456789012345678");
		await switching.setActivity({ details: "A", instance: false });
		expect(transports[0]?.activities).toEqual([{ details: "A", instance: false }]);

		switching.selectApplication("223456789012345678");
		await switching.setActivity({ details: "B", instance: false });
		expect(applicationIds).toEqual(["123456789012345678", "223456789012345678"]);
		expect(transports[0]).toMatchObject({ clearCount: 1, closeCount: 1 });
		expect(transports[1]?.activities).toEqual([{ details: "B", instance: false }]);
		await switching.clearActivity();
		expect(transports[1]).toMatchObject({ clearCount: 1, closeCount: 1 });
		await switching.close();
		expect(switching.getStatus()).toBe("disabled");
	});
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
