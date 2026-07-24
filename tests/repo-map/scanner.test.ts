import { lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { scanRepoMap, type ScannerFileSystem } from "../../src/repo-map/scanner.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-scanner-");

async function scan(overrides: Partial<Parameters<typeof scanRepoMap>[0]> = {}) {
	defaultIgnoreEngine.invalidate();
	const config = overrides.fileToolsConfig ?? defaultFileToolsConfig();
	const ignoreSnapshot = overrides.ignoreSnapshot ?? await createIgnoreSnapshot(temp.path, {
		builtinProfile: "none",
		gitignore: { enabled: true },
		caseSensitivity: "sensitive",
	});
	return await scanRepoMap({
		root: temp.path,
		fileToolsConfig: config,
		ignoreSnapshot,
		maxFiles: 100,
		maxFileBytes: 1024,
		concurrency: 2,
		...overrides,
	});
}

describe("Repo Map file scanner", () => {
	it("sorts files, applies ignore/blocked rules, skips symlinks, and records too-large files", async () => {
		await mkdir(path.join(temp.path, "src"));
		await mkdir(path.join(temp.path, "blocked"));
		await writeFile(path.join(temp.path, ".gitignore"), "ignored.txt\nignored-dir/\n");
		await writeFile(path.join(temp.path, "z.txt"), "z");
		await writeFile(path.join(temp.path, "src", "a.txt"), "a");
		await writeFile(path.join(temp.path, "large.bin"), Buffer.alloc(100));
		await writeFile(path.join(temp.path, "ignored.txt"), "ignored");
		await mkdir(path.join(temp.path, "ignored-dir"));
		await writeFile(path.join(temp.path, "ignored-dir", "hidden"), "hidden");
		await writeFile(path.join(temp.path, "blocked", "secret"), "secret");
		try {
			await symlink(path.join(temp.path, "z.txt"), path.join(temp.path, "file-link"));
			await symlink(path.join(temp.path, "src"), path.join(temp.path, "dir-link"));
		} catch {
			// Some platforms do not permit symlink creation in tests.
		}
		const config = defaultFileToolsConfig();
		config.blocked_path.push("blocked/");
		const result = await scan({ fileToolsConfig: config, maxFileBytes: 50 });
		expect(result.files.map((file) => file.path)).toEqual([".gitignore", "large.bin", "src/a.txt", "z.txt"]);
		const large = result.files.find((file) => file.path === "large.bin");
		expect(large).toMatchObject({ status: "too_large" });
		expect(large).not.toHaveProperty("contentHash");
		expect(result.summary).toMatchObject({ discovered: 4, indexed: 3, tooLarge: 1, hashed: 3, added: 4 });
	});

	it("reuses unchanged hashes and reports changed, added, and removed files", async () => {
		await writeFile(path.join(temp.path, "same.txt"), "same");
		await writeFile(path.join(temp.path, "change.txt"), "old");
		await writeFile(path.join(temp.path, "remove.txt"), "remove");
		const first = await scan();
		await writeFile(path.join(temp.path, "change.txt"), "new-and-different");
		await rm(path.join(temp.path, "remove.txt"));
		await writeFile(path.join(temp.path, "add.txt"), "add");
		const second = await scan({ previousFiles: first.files });
		expect(second.summary).toMatchObject({ reused: 1, hashed: 2, added: 1, changed: 1, removed: 1 });
		expect(second.files.find((file) => file.path === "same.txt")?.contentHash).toBe(first.files.find((file) => file.path === "same.txt")?.contentHash);
	});

	it("rehashes same-size content changes even when mtime is unchanged", async () => {
		const filePath = path.join(temp.path, "same-metadata.txt");
		await writeFile(filePath, "aaaa");
		const base = scannerFileSystem();
		const fixedMtimeFileSystem: ScannerFileSystem = {
			...base,
			async stat(target) {
				return fakeMtime(await base.stat(target), 1_000);
			},
		};
		const first = await scan({ fileSystem: fixedMtimeFileSystem });

		await writeFile(filePath, "bbbb");
		const second = await scan({ fileSystem: fixedMtimeFileSystem, previousFiles: first.files });

		expect(second.summary).toMatchObject({ changed: 1, reused: 0, hashed: 1 });
		expect(second.files[0]?.contentHash).not.toBe(first.files[0]?.contentHash);
	});

	it("fails before hashing when the eligible file limit is exceeded", async () => {
		await writeFile(path.join(temp.path, "a"), "a");
		await writeFile(path.join(temp.path, "b"), "b");
		await expect(scan({ maxFiles: 1 })).rejects.toMatchObject({ code: "SCAN_LIMIT_EXCEEDED" });
	});

	it("honors cancellation", async () => {
		await writeFile(path.join(temp.path, "a"), "a");
		const controller = new AbortController();
		controller.abort();
		await expect(scan({ signal: controller.signal })).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
	});

	it("records unreadable and repeatedly unstable files and bounds concurrent reads", async () => {
		for (const name of ["bad", "unstable", "one", "two"]) await writeFile(path.join(temp.path, name), name);
		const base = scannerFileSystem();
		let activeReads = 0;
		let maxReads = 0;
		let unstableStats = 0;
		const fileSystem: ScannerFileSystem = {
			...base,
			async stat(filePath) {
				const info = await base.stat(filePath);
				if (filePath.endsWith(`${path.sep}unstable`)) {
					unstableStats += 1;
					return fakeMtime(info, info.mtimeMs + unstableStats);
				}
				return info;
			},
			async readFile(filePath, signal, maxBytes) {
				if (filePath.endsWith(`${path.sep}bad`)) throw new Error("denied");
				activeReads += 1;
				maxReads = Math.max(maxReads, activeReads);
				await new Promise<void>((resolve) => setImmediate(resolve));
				try {
					return await base.readFile(filePath, signal, maxBytes);
				} finally {
					activeReads -= 1;
				}
			},
		};
		const result = await scan({ fileSystem, concurrency: 2 });
		expect(result.files.find((file) => file.path === "bad")?.status).toBe("unreadable");
		expect(result.files.find((file) => file.path === "unstable")?.status).toBe("unstable");
		expect(result.summary).toMatchObject({ unreadable: 1, unstable: 1 });
		expect(maxReads).toBeLessThanOrEqual(2);
	});
});

function scannerFileSystem(): ScannerFileSystem {
	return {
		async readdir(directory) { return await readdir(directory, { withFileTypes: true }); },
		async lstat(filePath) { return await lstat(filePath); },
		async stat(filePath) { return await stat(filePath); },
		async readFile(filePath) { return await readFile(filePath); },
	};
}

function fakeMtime(info: Stats, mtimeMs: number): Stats {
	return new Proxy(info, { get(target, property, receiver) { return property === "mtimeMs" ? mtimeMs : Reflect.get(target, property, receiver); } });
}
