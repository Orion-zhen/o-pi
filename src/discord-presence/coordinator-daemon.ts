import { createHash } from "node:crypto";
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { createPresenceCoordinatorServer, type PresenceCoordinatorServer } from "./coordinator-server.js";
import { prepareCoordinatorEndpoint } from "./coordinator-client.js";

const STARTUP_IDLE_TIMEOUT_MS = 5_000;
const endpoint = process.argv[2];
if (endpoint === undefined || endpoint.length === 0) throw new Error("Discord presence coordinator endpoint is required.");

await prepareCoordinatorEndpoint(endpoint);
const lockPath = coordinatorLockPath(endpoint);
const lock = await acquireLock(lockPath, endpoint);
if (lock === undefined) process.exit(0);

let server: PresenceCoordinatorServer | undefined;
let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
	if (closing !== undefined) return closing;
	closing = (async () => {
		await server?.close().catch(() => undefined);
		await lock.close().catch(() => undefined);
		await unlink(lockPath).catch(() => undefined);
	})().finally(() => {
		process.exitCode = 0;
	});
	return closing;
};

if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
server = createPresenceCoordinatorServer({
	endpoint,
	onEmpty: () => {
		void close();
	},
});
try {
	await server.listen();
} catch (error) {
	await close();
	throw error;
}

const startupTimer = setTimeout(() => {
	if (server?.participantCount() === 0) void close();
}, STARTUP_IDLE_TIMEOUT_MS);
startupTimer.unref();

process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

function coordinatorLockPath(socketPath: string): string {
	if (process.platform !== "win32") return `${socketPath}.lock`;
	const digest = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), `o-pi-discord-presence-${digest}.lock`);
}

async function acquireLock(lockPath: string, socketPath: string): Promise<FileHandle | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(String(process.pid));
			return handle;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			if (await socketAcceptsConnections(socketPath)) return undefined;
			const owner = await lockOwner(lockPath);
			if (owner !== undefined && processIsAlive(owner)) return undefined;
			await unlink(lockPath).catch(() => undefined);
			if (process.platform !== "win32") await unlink(socketPath).catch(() => undefined);
		}
	}
	return undefined;
}

async function lockOwner(lockPath: string): Promise<number | undefined> {
	const raw = await readFile(lockPath, "utf8").catch(() => "");
	const pid = Number(raw);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return hasCode(error, "EPERM");
	}
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (connected: boolean): void => {
			socket.destroy();
			resolve(connected);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
