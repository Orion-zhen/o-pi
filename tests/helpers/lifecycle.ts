import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

export interface TempDir {
	readonly path: string;
}

/** 为每个用例创建独立临时目录，并在用例结束后递归清理。 */
export function useTempDir(prefix: string): TempDir {
	let current: string | undefined;

	beforeEach(async () => {
		current = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
	});
	afterEach(async () => {
		if (current !== undefined) await rm(current, { recursive: true, force: true });
		current = undefined;
	});

	return {
		get path() {
			if (current === undefined) throw new Error(`Temporary directory ${prefix} is unavailable outside a test.`);
			return current;
		},
	};
}

/** 隔离会被用例改写的环境变量。 */
export function preserveEnv(...keys: string[]): void {
	let snapshot = new Map<string, string | undefined>();

	beforeEach(() => {
		snapshot = new Map(keys.map((key) => [key, process.env[key]]));
	});
	afterEach(() => {
		for (const [key, value] of snapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}
