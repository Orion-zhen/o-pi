import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ENDPOINT_ENV = "O_PET_ENDPOINT";

export function resolveOPetEndpoint(): string {
	const override = process.env[ENDPOINT_ENV];
	return override === undefined || override.length === 0 ? defaultOPetEndpoint() : override;
}

export function defaultOPetEndpoint(): string {
	if (process.platform === "win32") {
		const identity = createHash("sha256")
			.update(`${os.userInfo().username}\0${os.homedir()}`)
			.digest("hex")
			.slice(0, 16);
		return `\\\\.\\pipe\\o-pet-${identity}`;
	}
	if (process.platform === "linux") {
		const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
		if (runtimeDirectory === undefined || runtimeDirectory.length === 0) {
			throw new Error("o-pet requires XDG_RUNTIME_DIR on Linux.");
		}
		return path.join(runtimeDirectory, "o-pet.sock");
	}
	if (process.platform === "darwin") {
		return path.join(os.tmpdir(), `o-pet-${unixIdentity()}`, "o-pet.sock");
	}
	throw new Error(`o-pet does not support ${process.platform}.`);
}

/** 创建缺失的私有目录，并拒绝其他用户可访问的 Unix 端点目录。 */
export async function prepareOPetEndpoint(endpoint: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = path.dirname(endpoint);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const details = await stat(directory);
	if (details.uid !== unixUserId()) {
		throw new Error("o-pet endpoint directory is owned by another user.");
	}
	if ((details.mode & 0o077) !== 0) {
		throw new Error("o-pet endpoint directory must only be accessible by the current user.");
	}
}

function unixIdentity(): string {
	return String(unixUserId());
}

function unixUserId(): number {
	const getuid = process.getuid;
	if (getuid === undefined) throw new Error("o-pet requires process.getuid on Unix.");
	return getuid();
}
