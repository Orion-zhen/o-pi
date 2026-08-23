import { access } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordPresenceCoordinatorClient } from "../../src/discord-presence/coordinator-client.js";
import {
	parseClientMessage,
	parseServerMessage,
	readCoordinatorMessages,
	writeCoordinatorMessage,
} from "../../src/discord-presence/coordinator-protocol.js";
import {
	createPresenceCoordinatorServer,
	DiscordCoordinatorOutput,
	PresenceBroker,
} from "../../src/discord-presence/coordinator-server.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	coordinatedConfig,
	FakeCoordinatorOutput,
	FakeTransport,
} from "./fixtures.js";

const temp = useTempDir("o-pi-discord-presence-coordinator-");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function coordinatorEndpoint(name: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\o-pi-discord-presence-test-${process.pid}-${path.basename(temp.path)}-${name}`;
	}
	return path.join(temp.path, `${name}.sock`);
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(endpoint);
		const finish = (connected: boolean): void => {
			socket.destroy();
			resolve(connected);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

describe("Discord presence 多进程协调", () => {
	it.each([
		[{ type: "activity", activity: { instance: true }, activeAt: 1 }, "instance"],
		[{ type: "configure", config: { applicationId: "bad", updateIntervalMs: 5_000, retryIntervalMs: 30_000 } }, "Application ID"],
		[{ type: "register", participantId: "a", joinedAt: 1, config: coordinatedConfig(), activity: { instance: false } }, "together"],
	])("拒绝非法 IPC payload %#", (payload, message) => {
		expect(() => parseClientMessage(payload)).toThrow(message);
	});

	it("最近活跃者获得展示权，退出后回退且共享 elapsed 直到最后一员退出", async () => {
		const output = new FakeCoordinatorOutput();
		const broker = new PresenceBroker({ output });
		const a = { details: "A", startTimestamp: 110, instance: false } as const;
		const b = { details: "B", startTimestamp: 210, instance: false } as const;

		broker.register("a", coordinatedConfig(), 100, undefined, a, 1_000);
		expect(output.selections.at(-1)).toMatchObject({
			participantId: "a",
			activity: { details: "A", startTimestamp: 100 },
			groupStartedAt: 100,
		});
		broker.register("b", coordinatedConfig(), 200, undefined, b, 2_000);
		expect(output.selections.at(-1)).toMatchObject({
			participantId: "b",
			activity: { details: "B", startTimestamp: 100 },
		});
		broker.publish("a", { details: "A active", startTimestamp: 300, instance: false }, 3_000);
		expect(output.selections.at(-1)).toMatchObject({
			participantId: "a",
			activity: { details: "A active", startTimestamp: 100 },
		});

		broker.remove("a");
		expect(output.selections.at(-1)).toMatchObject({
			participantId: "b",
			activity: { details: "B", startTimestamp: 100 },
		});
		broker.remove("b");
		expect(output.clearCount).toBe(1);
		expect(broker.startedAt()).toBeUndefined();

		broker.register("c", coordinatedConfig(), 4_000, undefined, {
			details: "No timer", instance: false,
		}, 4_000);
		expect(output.selections.at(-1)).toMatchObject({
			participantId: "c",
			activity: { details: "No timer" },
			groupStartedAt: 4_000,
		});
		expect(output.selections.at(-1)?.activity).not.toHaveProperty("startTimestamp");
		broker.register("d", coordinatedConfig(), 5_000);
		broker.remove("c");
		expect(output.hideCount).toBe(1);
		broker.remove("d");
		expect(output.clearCount).toBe(2);
	});

	it("协调输出在全局间隔内合并状态并切换 Application", async () => {
		const transports: FakeTransport[] = [];
		const output = new DiscordCoordinatorOutput({
			createTransport: async () => {
				const transport = new FakeTransport();
				transports.push(transport);
				return transport;
			},
		});
		output.show({
			participantId: "a",
			config: coordinatedConfig("123456789012345678"),
			activity: { details: "A", startTimestamp: 100, instance: false },
			groupStartedAt: 100,
		});
		await vi.waitFor(() => expect(transports[0]?.activities).toHaveLength(1));
		output.show({
			participantId: "b",
			config: coordinatedConfig("223456789012345678"),
			activity: { details: "B", startTimestamp: 100, instance: false },
			groupStartedAt: 100,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.waitFor(() => expect(transports[1]?.activities.at(-1)).toMatchObject({ details: "B" }));
		expect(transports[0]).toMatchObject({ clearCount: 1, closeCount: 1 });
		await output.clear();
	});

	it("协调器重启后由存活参与者恢复原共享起点", () => {
		const output = new FakeCoordinatorOutput();
		const broker = new PresenceBroker({ output });
		broker.register("survivor", coordinatedConfig(), 2_000, 100, {
			details: "Recovered", startTimestamp: 2_000, instance: false,
		}, 3_000);
		expect(output.selections.at(-1)).toMatchObject({
			activity: { startTimestamp: 100 },
			groupStartedAt: 100,
		});
	});

	it("无响应的协调器不会阻塞激活，恢复后无需新事件即可发布初始状态", async () => {
		vi.useRealTimers();
		const endpoint = coordinatorEndpoint("silent");
		let acceptConnection: (() => void) | undefined;
		const accepted = new Promise<void>((resolve) => {
			acceptConnection = resolve;
		});
		const silentServer = createServer((socket) => {
			socket.resume();
			acceptConnection?.();
		});
		await new Promise<void>((resolve, reject) => {
			silentServer.once("error", reject);
			silentServer.listen(endpoint, resolve);
		});
		const coordinator = new DiscordPresenceCoordinatorClient({
			endpoint,
			participantId: "silent-client",
			now: () => 1_000,
			spawnDaemon: () => undefined,
			handshakeTimeoutMs: 20,
		});
		let server: ReturnType<typeof createPresenceCoordinatorServer> | undefined;
		try {
			await coordinator.activate(coordinatedConfig(), 100, {
				details: "Initial", startTimestamp: 100, instance: false,
			});
			expect(coordinator.getStatus()).not.toBe("disabled");
			await accepted;
			await new Promise<void>((resolve) => silentServer.close(() => resolve()));

			const output = new FakeCoordinatorOutput();
			server = createPresenceCoordinatorServer({ endpoint, output });
			await server.listen();
			await vi.waitFor(() => expect(output.selections.at(-1)).toMatchObject({
				participantId: "silent-client",
				activity: { details: "Initial", startTimestamp: 100 },
			}), { timeout: 5_000 });
		} finally {
			await coordinator.deactivate();
			if (silentServer.listening) {
				await new Promise<void>((resolve) => silentServer.close(() => resolve()));
			}
			await server?.close();
		}
	});

	it("两个真实 IPC 客户端共享协调器并按最新活动切换", async () => {
		vi.useRealTimers();
		const endpoint = coordinatorEndpoint("coordinator");
		const output = new FakeCoordinatorOutput();
		const server = createPresenceCoordinatorServer({ endpoint, output });
		await server.listen();
		const a = new DiscordPresenceCoordinatorClient({
			endpoint, participantId: "a", now: () => 1_000, spawnDaemon: () => undefined,
		});
		const b = new DiscordPresenceCoordinatorClient({
			endpoint, participantId: "b", now: () => 2_000, spawnDaemon: () => undefined,
		});
		try {
			await a.activate(coordinatedConfig(), 100);
			a.request({ details: "A", startTimestamp: 100, instance: false });
			await vi.waitFor(() => expect(output.selections.at(-1)?.participantId).toBe("a"));
			await b.activate(coordinatedConfig(), 200);
			b.request({ details: "B", startTimestamp: 200, instance: false });
			await vi.waitFor(() => expect(output.selections.at(-1)).toMatchObject({
				participantId: "b", activity: { startTimestamp: 100 },
			}));
			await b.deactivate();
			await vi.waitFor(() => expect(output.selections.at(-1)?.participantId).toBe("a"));
			await a.deactivate();
			await vi.waitFor(() => expect(server.participantCount()).toBe(0));
			await a.activate(coordinatedConfig(), 300);
			a.request({ details: "New group", startTimestamp: 300, instance: false });
			await vi.waitFor(() => expect(output.selections.at(-1)).toMatchObject({
				activity: { details: "New group", startTimestamp: 300 }, groupStartedAt: 300,
			}));
			await a.deactivate();
		} finally {
			await a.deactivate();
			await b.deactivate();
			await server.close();
		}
	});

	it("协调器异常重启后客户端恢复共享起点和最近活动者", async () => {
		vi.useRealTimers();
		const endpoint = coordinatorEndpoint("restart");
		const firstOutput = new FakeCoordinatorOutput();
		const firstServer = createPresenceCoordinatorServer({ endpoint, output: firstOutput });
		await firstServer.listen();
		const a = new DiscordPresenceCoordinatorClient({
			endpoint, participantId: "restart-a", now: () => 1_000, spawnDaemon: () => undefined,
		});
		const b = new DiscordPresenceCoordinatorClient({
			endpoint, participantId: "restart-b", now: () => 2_000, spawnDaemon: () => undefined,
		});
		let secondServer: ReturnType<typeof createPresenceCoordinatorServer> | undefined;
		try {
			await a.activate(coordinatedConfig(), 100);
			a.request({ details: "A", startTimestamp: 100, instance: false });
			await b.activate(coordinatedConfig(), 200);
			b.request({ details: "B", startTimestamp: 200, instance: false });
			await vi.waitFor(() => expect(firstOutput.selections.at(-1)?.participantId).toBe("restart-b"));
			await firstServer.close();

			const secondOutput = new FakeCoordinatorOutput();
			secondServer = createPresenceCoordinatorServer({ endpoint, output: secondOutput });
			await secondServer.listen();
			await vi.waitFor(() => expect(secondOutput.selections.at(-1)).toMatchObject({
				participantId: "restart-b",
				activity: { details: "B", startTimestamp: 100 },
				groupStartedAt: 100,
			}), { timeout: 5_000 });
		} finally {
			await a.deactivate();
			await b.deactivate();
			await firstServer.close();
			await secondServer?.close();
		}
	});

	it("首个客户端能按需启动守护进程，并在最后一员退出后清理 socket", async () => {
		vi.useRealTimers();
		const endpoint = coordinatorEndpoint("daemon");
		const coordinator = new DiscordPresenceCoordinatorClient({ endpoint, participantId: "daemon-test" });
		await coordinator.activate(coordinatedConfig(), Date.now());
		await vi.waitFor(() => expect(endpointAcceptsConnections(endpoint)).resolves.toBe(true), { timeout: 5_000 });

		const probe = createConnection(endpoint);
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => reject(error);
			probe.once("error", onError);
			probe.once("connect", () => {
				probe.off("error", onError);
				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			const removeReader = readCoordinatorMessages(probe, (value) => {
				try {
					if (parseServerMessage(value).type !== "status") return;
					removeReader();
					resolve();
				} catch (error) {
					reject(error);
				}
			}, reject);
			writeCoordinatorMessage(probe, {
				type: "register",
				participantId: "daemon-probe",
				joinedAt: Date.now(),
				config: coordinatedConfig(),
			});
		});
		await coordinator.deactivate();
		await new Promise<void>((resolve) => {
			probe.once("close", resolve);
			probe.end();
		});
		await vi.waitFor(async () => {
			await expect(endpointAcceptsConnections(endpoint)).resolves.toBe(false);
			if (process.platform !== "win32") await expect(access(`${endpoint}.lock`)).rejects.toThrow();
		}, { timeout: 5_000 });
	});
});

