import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultFileToolsConfig, type FileToolsConfig } from "../../src/file-tools-config/config.js";
import { fsFailure } from "../../src/filesystem/contracts/result.js";
import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { scanRepoMap, type RepoMapScannerFileSystem, type RepoMapScanInput } from "../../src/repo-map/scanner.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-scanner-");

type ScanOverrides = Partial<Omit<RepoMapScanInput, "filesystem" | "operation">> & {
	config?: FileToolsConfig;
	wrap?: (filesystem: RepoMapScannerFileSystem) => RepoMapScannerFileSystem;
};

async function scan(overrides: ScanOverrides = {}) {
	const config = overrides.config ?? scannerConfig();
	const runtime = new FileSystemRuntime();
	const opened = await runtime.open({ cwd: temp.path, policy: config.filesystem });
	if (!opened.ok) throw new Error(opened.error.message);
	try {
		const filesystem = overrides.wrap?.(opened.value.filesystem) ?? opened.value.filesystem;
		return await scanRepoMap({
			filesystem,
			operation: opened.value.context,
			maxFiles: 100,
			maxFileBytes: 1024,
			concurrency: 2,
			...(overrides.previousFiles === undefined ? {} : { previousFiles: overrides.previousFiles }),
			...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
			...(overrides.onProgress === undefined ? {} : { onProgress: overrides.onProgress }),
			...(overrides.maxFiles === undefined ? {} : { maxFiles: overrides.maxFiles }),
			...(overrides.maxFileBytes === undefined ? {} : { maxFileBytes: overrides.maxFileBytes }),
			...(overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency }),
		});
	} finally {
		opened.value.dispose();
		runtime.dispose();
	}
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
		} catch {}
		const config = scannerConfig();
		(config.filesystem.blockedPaths as string[]).push("blocked/");
		const result = await scan({ config, maxFileBytes: 50 });
		expect(result.files.map((file) => file.path)).toEqual([".gitignore", "large.bin", "src/a.txt", "z.txt"]);
		expect(result.files.find((file) => file.path === "large.bin")).toMatchObject({ status: "too_large" });
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
	});

	it("rehashes same-size content changes even when mtime is unchanged", async () => {
		const filePath = path.join(temp.path, "same-metadata.txt");
		await writeFile(filePath, "aaaa");
		const fixedMetadata = (filesystem: RepoMapScannerFileSystem): RepoMapScannerFileSystem => ({
			...filesystem,
			metadata: {
				...filesystem.metadata,
				async stat(ref, context) {
					const result = await filesystem.metadata.stat(ref, context);
					return result.ok ? { ok: true, value: { ...result.value, modifiedAtMs: 1_000 } } : result;
				},
			},
		});
		const first = await scan({ wrap: fixedMetadata });
		await writeFile(filePath, "bbbb");
		const second = await scan({ wrap: fixedMetadata, previousFiles: first.files });
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
		let activeReads = 0;
		let maxReads = 0;
		const result = await scan({
			wrap(filesystem) {
				return {
					...filesystem,
					content: {
						...filesystem.content,
						async readBytes(file, options, context) {
							if (file.displayPath === "bad") return fsFailure({ code: "access-denied", message: "denied", path: file.displayPath });
							if (file.displayPath === "unstable") return fsFailure({ code: "changed-during-read", message: "changed", path: file.displayPath });
							activeReads += 1;
							maxReads = Math.max(maxReads, activeReads);
							await new Promise<void>((resolve) => setImmediate(resolve));
							try { return await filesystem.content.readBytes(file, options, context); }
							finally { activeReads -= 1; }
						},
					},
				};
			},
		});
		expect(result.files.find((file) => file.path === "bad")?.status).toBe("unreadable");
		expect(result.files.find((file) => file.path === "unstable")?.status).toBe("unstable");
		expect(result.summary).toMatchObject({ unreadable: 1, unstable: 1 });
		expect(maxReads).toBeLessThanOrEqual(2);
	});
});

function scannerConfig(): FileToolsConfig {
	const config = defaultFileToolsConfig();
	const visibility = createVisibilityPolicy({
		ignore: { builtinProfile: "none", gitignore: { enabled: true }, caseSensitivity: "sensitive" },
	});
	return {
		...config,
		filesystem: { ...config.filesystem, visibility, fingerprint: visibility.fingerprint },
	};
}
