import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordPresenceCoordinatorClient } from "../../src/discord-presence/coordinator-client.js";
import { parseClientMessage, parseServerMessage, readCoordinatorMessages, writeCoordinatorMessage } from "../../src/discord-presence/coordinator-protocol.js";
import { createPresenceCoordinatorServer, type PresenceCoordinatorServer } from "../../src/discord-presence/coordinator-server.js";
import * as endpointModule from "../../src/discord-presence/endpoint.js";
import { DiscordCoordinatorOutput } from "../../src/discord-presence/output.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { coordinatedConfig, FakeCoordinatorOutput } from "./fixtures.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...await importOriginal<typeof import("node:child_process")>(),
	spawn: vi.fn(() => ({ on() {}, unref() {} })),
}));

const temp = useTempDir("o-pi-discord-presence-coordinator-");
const clients: DiscordPresenceCoordinatorClient[] = [];
const servers: PresenceCoordinatorServer[] = [];
let endpoint: string;
let output: FakeCoordinatorOutput;

beforeEach(() => {
	endpoint = process.platform === "win32"
		? `\\\\.\\pipe\\o-pi-discord-presence-test-${process.pid}-${path.basename(temp.path)}`
		: path.join(temp.path, "coordinator.sock");
	vi.spyOn(endpointModule, "defaultCoordinatorEndpoint").mockReturnValue(endpoint);
	vi.mocked(spawn).mockReset();
	output = new FakeCoordinatorOutput();
	const prototype = DiscordCoordinatorOutput.prototype;
	vi.spyOn(prototype, "show").mockImplementation(output.show.bind(output));
	vi.spyOn(prototype, "hide").mockImplementation(output.hide.bind(output));
	vi.spyOn(prototype, "dispose").mockImplementation(output.dispose.bind(output));
	vi.spyOn(prototype, "getStatus").mockImplementation(output.getStatus.bind(output));
	vi.spyOn(prototype, "onStatus").mockImplementation(output.onStatus.bind(output));
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.deactivate()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
	vi.restoreAllMocks();
});

function client(): DiscordPresenceCoordinatorClient {
	const instance = new DiscordPresenceCoordinatorClient();
	clients.push(instance);
	return instance;
}

async function startServer(): Promise<PresenceCoordinatorServer> {
	const server = createPresenceCoordinatorServer({ endpoint, onEmpty: () => { void server.close(); } });
	servers.push(server);
	await server.listen();
	return server;
}

function endpointAcceptsConnections(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(endpoint);
		const finish = (connected: boolean): void => { socket.destroy(); resolve(connected); };
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

	it("最近活跃者获得展示权，退出后恢复前一参与者，最后退出时只销毁一次输出", async () => {
		const server = await startServer();
		const a = client();
		const b = client();
		await a.activate(coordinatedConfig(), 100, { details: "A", startTimestamp: 110, instance: false });
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "A", startTimestamp: 100 }));
		await b.activate(coordinatedConfig(), 200, { details: "B", startTimestamp: 210, instance: false });
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "B", startTimestamp: 100 }));
		a.request({ details: "A active", startTimestamp: 300, instance: false });
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity.details).toBe("A active"));
		await a.deactivate();
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "B", startTimestamp: 100 }));
		await b.deactivate();
		await vi.waitFor(() => expect(output.disposeCount).toBe(1));
		await server.close();
		expect(output.disposeCount).toBe(1);
	});

	it("剩余参与者没有订阅活动时隐藏输出，新的活动仍能恢复展示", async () => {
		await startServer();
		const a = client();
		const b = client();
		await a.activate(coordinatedConfig(), 100, { details: "No timer", instance: false });
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity.details).toBe("No timer"));
		expect(output.selections.at(-1)?.activity).not.toHaveProperty("startTimestamp");
		await b.activate(coordinatedConfig(), 200);
		await vi.waitFor(() => expect(b.getStatus()).toBe("connected"));
		await a.deactivate();
		await vi.waitFor(() => expect(output.hideCount).toBe(1));
		expect(output.disposeCount).toBe(0);
		b.request({ details: "Recovered", startTimestamp: 200, instance: false });
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "Recovered", startTimestamp: 100 }));
	});

	it("同一时刻发布时按到达顺序选择，未发布活动的早期进程仍更新共享起点", async () => {
		await startServer();
		const a = client();
		const b = client();
		for (const [participant, details] of [[a, "A"], [b, "B"]] as const) {
			await participant.activate(coordinatedConfig(), 200);
			vi.spyOn(Date, "now").mockReturnValue(1_000);
			participant.request({ details, startTimestamp: 200, instance: false });
			vi.mocked(Date.now).mockRestore();
			await vi.waitFor(() => expect(output.selections.at(-1)?.activity.details).toBe(details));
		}
		await client().activate(coordinatedConfig(), 100);
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "B", startTimestamp: 100 }));
		await b.activate(coordinatedConfig("223456789012345678"), 200);
		await vi.waitFor(() => expect(output.selections.at(-1)?.config.applicationId).toBe("223456789012345678"));
	});

	it("无响应的协调器不会阻塞激活，握手超时后无需新事件即可恢复初始状态", async () => {
		let acceptConnection = () => {};
		const accepted = new Promise<void>((resolve) => { acceptConnection = resolve; });
		const silentServer = createServer((socket) => { socket.resume(); acceptConnection(); });
		await new Promise<void>((resolve, reject) => {
			silentServer.once("error", reject);
			silentServer.listen(endpoint, resolve);
		});
		const coordinator = client();
		try {
			await coordinator.activate(coordinatedConfig(), 100, { details: "Initial", startTimestamp: 100, instance: false });
			expect(coordinator.getStatus()).not.toBe("disabled");
			await accepted;
			await new Promise<void>((resolve) => silentServer.close(() => resolve()));
			await startServer();
			await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "Initial", startTimestamp: 100 }));
		} finally {
			await coordinator.deactivate();
			if (silentServer.listening) await new Promise<void>((resolve) => silentServer.close(() => resolve()));
		}
	});

	it("握手期间的更新不会丢失，关闭握手连接后可以立即重新启用", async () => {
		const messages: ReturnType<typeof parseClientMessage>[] = [];
		let peer: Socket | undefined;
		const server = createServer((socket) => {
			peer = socket;
			const stop = readCoordinatorMessages(socket, (value) => messages.push(parseClientMessage(value)), () => socket.destroy());
			socket.on("error", () => {});
			socket.once("close", stop);
		});
		await new Promise<void>((resolve) => server.listen(endpoint, resolve));
		const coordinator = client();
		try {
			await coordinator.activate(coordinatedConfig(), 100, { details: "Initial", instance: false });
			await vi.waitFor(() => expect(messages).toHaveLength(1));
			await coordinator.activate(coordinatedConfig("223456789012345678"), 100);
			coordinator.request({ details: "Latest", instance: false });
			if (peer === undefined) throw new Error("test socket missing");
			writeCoordinatorMessage(peer, { type: "status", status: "connected", groupStartedAt: 100 });
			await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ type: "activity", activity: { details: "Latest" } }));
			expect(messages).toContainEqual({ type: "configure", config: coordinatedConfig("223456789012345678") });

			const stopping = coordinator.deactivate();
			await coordinator.activate(coordinatedConfig(), 200, { details: "Reenabled", instance: false });
			await stopping;
			await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ type: "register", joinedAt: 200, activity: { details: "Reenabled" } }));
			expect(coordinator.getStatus()).not.toBe("disabled");
			await coordinator.deactivate();
			expect(coordinator.getStatus()).toBe("disabled");
		} finally {
			await coordinator.deactivate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("协调器异常重启后恢复已退出参与者的共享起点和存活参与者的最近活动", async () => {
		const firstServer = await startServer();
		const early = client();
		const a = client();
		const b = client();
		await early.activate(coordinatedConfig(), 100);
		for (const [participant, joinedAt, details, activeAt] of [[a, 200, "A", 1_000], [b, 300, "B", 2_000]] as const) {
			await participant.activate(coordinatedConfig(), joinedAt);
			vi.spyOn(Date, "now").mockReturnValue(activeAt);
			participant.request({ details, startTimestamp: joinedAt, instance: false });
			vi.mocked(Date.now).mockRestore();
		}
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "B", startTimestamp: 100 }));
		await early.deactivate();
		await firstServer.close();
		output.selections.length = 0;
		await startServer();
		await vi.waitFor(() => expect(output.selections.at(-1)?.activity).toMatchObject({ details: "B", startTimestamp: 100 }));
	});

	it("首个客户端按需启动守护进程，最后一员退出后清理端点和锁", async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		vi.mocked(spawn).mockImplementation(actual.spawn);
		const coordinator = client();
		await coordinator.activate(coordinatedConfig(), Date.now());
		await vi.waitFor(() => expect(endpointAcceptsConnections()).resolves.toBe(true), { timeout: 5_000 });
		const probe = createConnection(endpoint);
		try {
			await new Promise<void>((resolve, reject) => {
				probe.once("error", reject);
				probe.once("connect", resolve);
			});
			await new Promise<void>((resolve, reject) => {
				const stop = readCoordinatorMessages(probe, (value) => {
					if (parseServerMessage(value).type !== "status") return;
					stop();
					resolve();
				}, reject);
				writeCoordinatorMessage(probe, { type: "register", participantId: "daemon-probe", joinedAt: Date.now(), config: coordinatedConfig() });
			});
		} finally {
			await coordinator.deactivate();
			await new Promise<void>((resolve) => { probe.once("close", resolve); probe.end(); });
		}
		await vi.waitFor(async () => {
			await expect(endpointAcceptsConnections()).resolves.toBe(false);
			if (process.platform !== "win32") await expect(access(`${endpoint}.lock`)).rejects.toThrow();
		}, { timeout: 5_000 });
	});
});
