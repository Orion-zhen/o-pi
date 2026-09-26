import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { parseServerMessage, readCoordinatorMessages, writeCoordinatorMessage } from "../../src/harness/discord-presence/coordinator-protocol.ts";

test.use({ mode: "desktop" });
test.beforeEach(({}, info) => { test.skip(info.project.name !== "desktop", "仅验证桌面打包入口"); });

test("打包后的协调进程在 Node 模式启动，多个空闲会话共享进程并正常退出", async ({ gui: { app }, workspace: { home, env } }) => {
	const { executable, entry } = await app.evaluate(({ app }) => ({ executable: process.execPath, entry: app.getAppPath() }));
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\opi-desktop-test-${path.basename(home)}` : path.join(home, "presence.sock");
	const children: ChildProcess[] = [];
	const sockets: Socket[] = [];
	let stderr = "";
	const start = () => {
		const child = spawn(executable, [path.join(entry, "backend.mjs"), "--opi-discord-daemon", endpoint], {
			env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe"],
		});
		children.push(child);
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		return child;
	};
	const connect = () => new Promise<Socket | undefined>((resolve) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => { sockets.push(socket); resolve(socket); });
		socket.once("error", () => { socket.destroy(); resolve(undefined); });
	});
	const register = (socket: Socket, participantId: string, joinedAt: number) => new Promise<number>((resolve, reject) => {
		const remove = readCoordinatorMessages(socket, (value) => {
			const message = parseServerMessage(value);
			remove();
			if (message.type === "error") reject(new Error(message.message));
			else resolve(message.groupStartedAt);
		}, reject);
		writeCoordinatorMessage(socket, { type: "register", participantId, joinedAt,
			config: { applicationId: "123456789012345678", updateIntervalMs: 5000, retryIntervalMs: 30000 } });
	});
	try {
		const daemon = start();
		let first: Socket | undefined;
		await expect(async () => {
			if (daemon.exitCode !== null) throw new Error(`协调进程退出: ${daemon.exitCode}\n${stderr.slice(-1500)}`);
			first = await connect();
			expect(first).toBeDefined();
		}).toPass({ timeout: 10_000 });
		if (!first) throw new Error("缺少协调连接");
		expect(await register(first, "first", 100)).toBe(100);
		const duplicate = start();
		await expect.poll(() => duplicate.exitCode).toBe(0);
		const second = await connect();
		if (!second) throw new Error("共享协调进程未接受第二个连接");
		expect(await register(second, "second", 200)).toBe(100);
		first.destroy();
		expect(daemon.exitCode).toBeNull();
		second.destroy();
		await expect.poll(() => daemon.exitCode).toBe(0);
		expect(stderr).not.toContain("SyntaxError");
	} finally {
		for (const socket of sockets) socket.destroy();
		await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			child.kill("SIGKILL");
		})));
	}
});
