import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { cp } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { test, expect } from "./workspace.ts";
import { parseServerMessage, readCoordinatorMessages, writeCoordinatorMessage } from "../../src/harness/discord-presence/coordinator-protocol.ts";

const executable: unknown = createRequire(import.meta.url)("electron");
if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件路径");

test("打包后端可在 Node 模式启动协调进程并正常退出，无需桌面窗口", async ({ workspace: { home, cwd, env } }) => {
	const entry = path.join(home, "desktop-app");
	await cp(path.resolve("dist/desktop/app"), entry, { recursive: true });
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\opi-desktop-test-${path.basename(home)}` : path.join(home, "presence.sock");
	const child = spawn(executable, [path.join(entry, "backend.mjs"), "--opi-discord-daemon", endpoint], {
		cwd, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
	});
	let stderr = "";
	let peer: Socket | undefined;
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	try {
		await expect(async () => {
			if (child.exitCode !== null) throw new Error(`协调进程退出: ${child.exitCode}\n${stderr}`);
			peer = await new Promise<Socket | undefined>((resolve) => {
				const socket = createConnection(endpoint);
				socket.once("connect", () => resolve(socket));
				socket.once("error", () => { socket.destroy(); resolve(undefined); });
			});
			expect(peer).toBeDefined();
		}).toPass({ timeout: 10_000 });
		if (!peer) throw new Error("协调进程未接受连接");
		const socket = peer;
		const status = new Promise<unknown>((resolve, reject) => {
			const stop = readCoordinatorMessages(socket, (value) => { stop(); resolve(parseServerMessage(value)); }, reject);
			writeCoordinatorMessage(socket, { type: "register", participantId: "probe", joinedAt: 100,
				config: { applicationId: "123456789012345678", updateIntervalMs: 5000, retryIntervalMs: 30000 } });
		});
		expect(await status).toMatchObject({ type: "status", groupStartedAt: 100 });
		socket.destroy();
		await expect.poll(() => child.exitCode).toBe(0);
	} finally {
		peer?.destroy();
		if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			child.kill("SIGKILL");
		});
	}
});
