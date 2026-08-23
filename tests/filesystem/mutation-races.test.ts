import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { deferredVoid as deferred, expectFsOk as expectOk, overrideNativeFileSystem as nativeOverride, textBytes as bytes } from "./fixtures.js";
import { commitBytes, useMutationFixture } from "./mutation-fixtures.js";

const test = useMutationFixture("o-pi-mutation-races-");
const { commitPath, openRuntime, policy, resolveTarget, track } = test;
let workspace: string;
beforeEach(() => { workspace = test.workspace; });

describe("filesystem mutation commit boundaries", () => {
	it("rejects an optimistic commit when an external process changes the snapshot", async () => {
		await writeFile(path.join(workspace, "stale.txt"), "before");
		const opened = await openRuntime();
		const target = await resolveTarget(opened, "stale.txt");
		const entered = deferred();
		const release = deferred();
		const pending = opened.filesystem.mutations.run(target, { createParents: false }, async (snapshot) => {
			expect(snapshot).toMatchObject({ exists: true, hash: contentHash(bytes("before")) });
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("unsafe") };
		});
		await entered.promise;
		await writeFile(path.join(workspace, "stale.txt"), "external");
		release.resolve();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "changed-during-read" } });
		expect(await readFile(path.join(workspace, "stale.txt"), "utf8")).toBe("external");
	});
	it("rechecks live existence and read failures", async () => {
		const opened = await openRuntime();
		await writeFile(path.join(workspace, "removed.txt"), "before");
		const removedTarget = await resolveTarget(opened, "removed.txt");
		await expect(opened.filesystem.mutations.run(
			removedTarget,
			{ createParents: false },
			async () => {
				await rm(path.join(workspace, "removed.txt"));
				return { type: "commit", bytes: bytes("unsafe") };
			},
		)).resolves.toMatchObject({ ok: false, error: { code: "changed-during-read" } });

		await writeFile(path.join(workspace, "live-read.txt"), "before");
		let reads = 0;
		const base = new NodeNativeFileSystem();
		const liveReadNative = nativeOverride({
			async open(file, options) {
				reads += 1;
				if (reads === 2) throw new NativeFileSystemError("access-denied", "open", file);
				return await base.open(file, options);
			},
		});
		const liveReadOpen = await openRuntime([], liveReadNative);
		await expect(commitBytes(
			liveReadOpen,
			await resolveTarget(liveReadOpen, "live-read.txt"),
			bytes("unsafe"),
			{ createParents: false },
		)).resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		await writeFile(path.join(workspace, "live-abort.txt"), "before");
		const finalReadAbort = new AbortController();
		let abortReads = 0;
		const liveAbortNative = nativeOverride({
			async open(file, options) {
				const handle = await base.open(file, options);
				abortReads += 1;
				if (abortReads === 2) finalReadAbort.abort();
				return handle;
			},
		});
		const liveAbortOpen = await openRuntime([], liveAbortNative, finalReadAbort.signal);
		await expect(commitBytes(
			liveAbortOpen,
			await resolveTarget(liveAbortOpen, "live-abort.txt"),
			bytes("unsafe"),
			{ createParents: false },
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});
	it.skipIf(process.platform === "win32")("rejects a blocked destination introduced during transform", async () => {
		const protectedDirectory = path.join(test.root, "transform-protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		await writeFile(path.join(workspace, "transform-link.txt"), "safe");
		const opened = await openRuntime([`${protectedDirectory}/`]);
		const target = await resolveTarget(opened, "transform-link.txt");
		const result = await opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			await rm(path.join(workspace, "transform-link.txt"));
			await symlink(protectedFile, path.join(workspace, "transform-link.txt"));
			return { type: "commit", bytes: bytes("unsafe") };
		});
		expect(result).toMatchObject({ ok: false, error: { code: "blocked" } });
		expect(await readFile(protectedFile, "utf8")).toBe("secret");
	});
	it.skipIf(process.platform === "win32")("rejects a commit when a target symlink changes canonical identity", async () => {
		await writeFile(path.join(workspace, "one.txt"), "same");
		await writeFile(path.join(workspace, "two.txt"), "same");
		await symlink(path.join(workspace, "one.txt"), path.join(workspace, "link.txt"));
		const opened = await openRuntime();
		const target = await resolveTarget(opened, "link.txt");
		const entered = deferred();
		const release = deferred();
		const pending = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("unsafe") };
		});
		await entered.promise;
		await rm(path.join(workspace, "link.txt"));
		await symlink(path.join(workspace, "two.txt"), path.join(workspace, "link.txt"));
		release.resolve();
		await expect(pending).resolves.toMatchObject({
			ok: false,
			error: { code: "changed-during-read", details: { actual: "different-target" } },
		});
		expect(await readFile(path.join(workspace, "one.txt"), "utf8")).toBe("same");
		expect(await readFile(path.join(workspace, "two.txt"), "utf8")).toBe("same");
	});
	it.skipIf(process.platform === "win32")("replaces rather than follows a final symlink introduced after validation", async () => {
		const protectedDirectory = path.join(test.root, "commit-race-protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		const racedFile = path.join(workspace, "commit-race.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		await writeFile(racedFile, "safe");
		const base = new NodeNativeFileSystem();
		const racingNative = nativeOverride({
			async atomicReplace(file, value, options) {
				return await base.atomicReplace(file, value, {
					...options,
					beforeCommit: async () => {
						const result = await options.beforeCommit();
						await rm(racedFile);
						await symlink(protectedFile, racedFile);
						return result;
					},
				});
			},
		});
		const opened = await openRuntime([`${protectedDirectory}${path.sep}`], racingNative);
		const result = expectOk(await commitPath(opened, "commit-race.txt", bytes("replacement"), { createParents: false }));
		expect(result).toMatchObject({ committed: true, receipt: { created: false } });
		expect(await readFile(protectedFile, "utf8")).toBe("secret");
		expect(await readFile(racedFile, "utf8")).toBe("replacement");
	});
	it("cleans the temporary file when cancelled after final validation", async () => {
		const file = path.join(workspace, "cancel-temp.txt");
		await writeFile(file, "before");
		const controller = new AbortController();
		const base = new NodeNativeFileSystem();
		const cancellingNative = nativeOverride({
			async atomicReplace(destination, value, options) {
				return await base.atomicReplace(destination, value, {
					...options,
					beforeCommit: async () => {
						const result = await options.beforeCommit();
						controller.abort("cancel before rename");
						return result;
					},
				});
			},
		});
		const opened = await openRuntime([], cancellingNative, controller.signal);
		await expect(commitPath(opened, "cancel-temp.txt", bytes("unsafe"), { createParents: false }))
			.resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await readFile(file, "utf8")).toBe("before");
		expect((await readdir(workspace)).filter((name) => name.startsWith(".pi-") && name.endsWith(".tmp"))).toEqual([]);
	});
	it.skipIf(process.platform === "win32")("preserves an existing file mode across mutation commit", async () => {
		const file = path.join(workspace, "mode.txt");
		await writeFile(file, "before");
		await chmod(file, 0o640);
		const opened = await openRuntime();
		expect(expectOk(await commitPath(opened, "mode.txt", bytes("after"), { createParents: false })))
			.toMatchObject({ committed: true, receipt: { created: false } });
		expect((await stat(file)).mode & 0o7777).toBe(0o640);
	});
	it("maps write failures and keeps committed writes successful after cancellation or observer failure", async () => {
		const observerRuntime = track(new FileSystemRuntime());
		const observerOpen = expectOk(await observerRuntime.open({
			cwd: workspace,
			policy: policy(),
			onCommitted() { throw new Error("observer unavailable"); },
		}));
		const observedTarget = await resolveTarget(observerOpen, "observed.txt");
		expect(expectOk(await commitBytes(
			observerOpen,
			observedTarget,
			bytes("observed"),
			{ createParents: false },
		))).toMatchObject({ committed: true, receipt: { created: true } });
		expect(await readFile(path.join(workspace, "observed.txt"), "utf8")).toBe("observed");

		const failingNative = nativeOverride({
			async atomicReplace(file) { throw new NativeFileSystemError("access-denied", "atomic-replace", file); },
		});
		const failedOpen = await openRuntime([], failingNative);
		const failedTarget = await resolveTarget(failedOpen, "failed.txt");
		await expect(commitBytes(failedOpen, failedTarget, bytes("no"), { createParents: false }))
			.resolves.toMatchObject({ ok: false, error: { code: "write-failed" } });

		const brokenNative = nativeOverride({
			async atomicReplace() { throw new Error("injected implementation failure"); },
		});
		const brokenOpen = await openRuntime([], brokenNative);
		await expect(commitPath(brokenOpen, "broken.txt", bytes("no"), { createParents: false }))
			.rejects.toThrow("injected implementation failure");

		const controller = new AbortController();
		const committingNative = nativeOverride({
			async atomicReplace(file, value, options) {
				const result = await new NodeNativeFileSystem().atomicReplace(file, value, options);
				controller.abort();
				return result;
			},
		});
		const committedOpen = await openRuntime([], committingNative, controller.signal);
		const committed = await commitPath(committedOpen, "committed.txt", bytes("yes"), { createParents: false });
		expect(expectOk(committed)).toMatchObject({
			committed: true,
			receipt: { hash: contentHash(bytes("yes")) },
		});
		expect(await readFile(path.join(workspace, "committed.txt"), "utf8")).toBe("yes");
	});
});
