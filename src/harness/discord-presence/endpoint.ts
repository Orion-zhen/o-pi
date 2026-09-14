import { createHash } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultCoordinatorEndpoint(): string {
	const identity = typeof process.getuid === "function"
		? String(process.getuid())
		: createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
	if (process.platform === "win32") return `\\\\.\\pipe\\o-pi-discord-presence-${identity}`;
	return path.join(os.tmpdir(), `o-pi-${identity}`, "discord-presence.sock");
}

export async function prepareCoordinatorEndpoint(endpoint: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = path.dirname(endpoint);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const details = await stat(directory);
	if (!details.isDirectory()) throw new Error("Discord presence coordinator path is not a directory.");
	if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
		throw new Error("Discord presence coordinator directory is owned by another user.");
	}
	await chmod(directory, 0o700);
}
