import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TargetRef } from "../../src/filesystem/contracts/path.js";
import type { FilesystemPolicy } from "../../src/filesystem/contracts/policy.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import type { VisibilityService } from "../../src/filesystem/contracts/visibility.js";
import {
	FileSystemRuntime,
	type WorkspaceFileSystemLease,
} from "../../src/filesystem/runtime.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import { MutationQueue } from "../../src/filesystem/platform/node/mutation-queue.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-mutation-runtime-");
let workspace: string;
let runtimes: FileSystemRuntime[];

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
	runtimes = [];
});

afterEach(() => {
	for (const runtime of runtimes) runtime.dispose();
});

describe("filesystem mutation runtime", () => {
	it("releases active queue entries and rejects waiters and new work when disposed", async () => {
		const queue = new MutationQueue();
		const entered = deferred();
		const release = deferred();
		const active = queue.run("same", undefined, async () => {
			entered.resolve();
			await release.promise;
			return "active";
		});
		await entered.promise;
		const waiting = queue.run("same", undefined, async () => "waiting");
		queue.dispose();
		queue.dispose();
		await expect(waiting).rejects.toMatchObject({ reason: "disposed" });
		await expect(queue.run("new", undefined, async () => "new")).rejects.toMatchObject({ reason: "disposed" });
		release.resolve();
		await expect(active).resolves.toBe("active");

		const abortedQueue = new MutationQueue();
		const before = new AbortController();
		before.abort();
		await expect(abortedQueue.run("before", before.signal, async () => "unexpected")).rejects.toMatchObject({ reason: "aborted" });
		const controller = new AbortController();
		const aborted = abortedQueue.run("aborted", controller.signal, async () => "unexpected");
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ reason: "aborted" });
		abortedQueue.dispose();
	});
	it("maps visibility startup failures and aborts a workspace disposed while opening", async () => {
		const unavailable: VisibilityService = {
			async createSnapshot() { throw new NativeFileSystemError("access-denied", "visibility", workspace); },
			invalidate() {},
		};
		const failedRuntime = track(new FileSystemRuntime({ visibility: unavailable }));
		await expect(failedRuntime.open({ cwd: workspace, policy: policy() })).resolves.toMatchObject({
			ok: false,
			error: { code: "access-denied" },
		});

		const controller = new AbortController();
		const delegate = new WorkspaceVisibilityService();
		const aborting: VisibilityService = {
			async createSnapshot(root, visibilityPolicy, context) {
				const snapshot = await delegate.createSnapshot(root, visibilityPolicy, context);
				controller.abort();
				return snapshot;
			},
			invalidate(root) { delegate.invalidate(root); },
		};
		const abortedRuntime = track(new FileSystemRuntime({ visibility: aborting }));
		await expect(abortedRuntime.open({
			cwd: workspace,
			policy: policy(),
			context: { signal: controller.signal },
		})).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("creates parents, fully overwrites files, and returns before/after versions", async () => {
		const opened = await openRuntime();
		const target = await resolveTarget(opened, "nested/file.txt");
		const firstBytes = bytes("first\n");
		const first = expectOk(await opened.filesystem.mutations.overwrite(
			target,
			firstBytes,
			{ createParents: true },
			opened.context,
		));
		expect(first).toMatchObject({
			created: true,
			hash: contentHash(firstBytes),
			sizeBytes: firstBytes.byteLength,
			target: { displayPath: "nested/file.txt" },
		});

		const secondBytes = bytes("second\n");
		const second = expectOk(await opened.filesystem.mutations.overwrite(
			first.target,
			secondBytes,
			{ createParents: true },
			opened.context,
		));
		expect(second).toMatchObject({
			created: false,
			before: { hash: first.hash, sizeBytes: first.sizeBytes },
			hash: contentHash(secondBytes),
		});
		expect(await readFile(path.join(workspace, "nested/file.txt"), "utf8")).toBe("second\n");
	});

	it("serializes the same target, runs different targets concurrently, and releases after exceptions", async () => {
		const opened = await openRuntime();
		const same = await resolveTarget(opened, "same.txt");
		const other = await resolveTarget(opened, "other.txt");
		const firstEntered = deferred();
		const firstRelease = deferred();
		let secondEntered = false;
		const first = opened.filesystem.mutations.run(same, { createParents: false }, async () => {
			firstEntered.resolve();
			await firstRelease.promise;
			return { type: "commit", bytes: bytes("one") };
		}, opened.context);
		await firstEntered.promise;
		const second = opened.filesystem.mutations.run(same, { createParents: false }, () => {
			secondEntered = true;
			return { type: "commit", bytes: bytes("two") };
		}, opened.context);
		const otherEntered = deferred();
		const otherRelease = deferred();
		const parallel = opened.filesystem.mutations.run(other, { createParents: false }, async () => {
			otherEntered.resolve();
			await otherRelease.promise;
			return { type: "reject", reason: "parallel-done" };
		}, opened.context);
		await otherEntered.promise;
		expect(secondEntered).toBe(false);
		otherRelease.resolve();
		firstRelease.resolve();
		expect(expectOk(await first)).toMatchObject({ committed: true });
		expect(expectOk(await second)).toMatchObject({ committed: true });
		expect(expectOk(await parallel)).toMatchObject({ committed: false, reason: "parallel-done" });

		const failureEntered = deferred();
		const failureRelease = deferred();
		const failure = opened.filesystem.mutations.run(same, { createParents: false }, async () => {
			failureEntered.resolve();
			await failureRelease.promise;
			throw new Error("transform failed");
		}, opened.context);
		await failureEntered.promise;
		const afterFailure = opened.filesystem.mutations.overwrite(same, bytes("recovered"), { createParents: false }, opened.context);
		failureRelease.resolve();
		await expect(failure).rejects.toThrow("transform failed");
		expect(expectOk(await afterFailure)).toMatchObject({ hash: contentHash(bytes("recovered")) });
	});

	it("maps parent/read failures and aborts before transform or commit", async () => {
		const mkdirNative = nativeOverride({
			async mkdir(directory) { throw new NativeFileSystemError("access-denied", "mkdir", directory); },
		});
		const mkdirOpen = await openRuntime([], mkdirNative);
		await expect(mkdirOpen.filesystem.mutations.overwrite(
			await resolveTarget(mkdirOpen, "nested/fail.txt"),
			bytes("fail"),
			{ createParents: true },
			mkdirOpen.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		await writeFile(path.join(workspace, "read-fail.txt"), "before");
		const readNative = nativeOverride({
			async open(file) { throw new NativeFileSystemError("access-denied", "open", file); },
		});
		const readOpen = await openRuntime([], readNative);
		await expect(readOpen.filesystem.mutations.overwrite(
			await resolveTarget(readOpen, "read-fail.txt"),
			bytes("fail"),
			{ createParents: false },
			readOpen.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		await writeFile(path.join(workspace, "abort-read.txt"), "before");
		const readAbort = new AbortController();
		const abortingReadNative = nativeOverride({
			async open(file, options) {
				const handle = await new NodeNativeFileSystem().open(file, options);
				readAbort.abort();
				return handle;
			},
		});
		const abortReadOpen = await openRuntime([], abortingReadNative);
		let transformed = false;
		await expect(abortReadOpen.filesystem.mutations.run(
			await resolveTarget(abortReadOpen, "abort-read.txt"),
			{ createParents: false },
			() => {
				transformed = true;
				return { type: "commit", bytes: bytes("unsafe") };
			},
			{ signal: readAbort.signal },
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(transformed).toBe(false);

		const transformAbort = new AbortController();
		const abortTarget = await resolveTarget(abortReadOpen, "abort-transform.txt");
		await expect(abortReadOpen.filesystem.mutations.run(
			abortTarget,
			{ createParents: false },
			() => {
				transformAbort.abort();
				return { type: "commit", bytes: bytes("unsafe") };
			},
			{ signal: transformAbort.signal },
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("cancels queued work without blocking later mutations", async () => {
		const opened = await openRuntime();
		const target = await resolveTarget(opened, "queued.txt");
		const activeEntered = deferred();
		const activeRelease = deferred();
		const active = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			activeEntered.resolve();
			await activeRelease.promise;
			return { type: "reject", reason: "released" };
		}, opened.context);
		await activeEntered.promise;

		const controller = new AbortController();
		const cancelled = opened.filesystem.mutations.overwrite(target, bytes("cancelled"), { createParents: false }, { signal: controller.signal });
		controller.abort();
		await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		const later = opened.filesystem.mutations.overwrite(target, bytes("later"), { createParents: false }, opened.context);
		activeRelease.resolve();
		expect(expectOk(await active)).toMatchObject({ committed: false });
		expect(expectOk(await later)).toMatchObject({ hash: contentHash(bytes("later")) });
	});

	it("rejects foreign refs, directories, and optimistic commits after target changes", async () => {
		const first = await openRuntime();
		const second = await openRuntime();
		const foreign = await resolveTarget(first, "foreign.txt");
		await expect(second.filesystem.mutations.overwrite(
			foreign,
			bytes("foreign"),
			{ createParents: false },
			second.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "invalid-path" } });

		await mkdir(path.join(workspace, "directory"));
		const directory = await resolveTarget(first, "directory");
		await expect(first.filesystem.mutations.overwrite(
			directory,
			bytes("not-file"),
			{ createParents: false },
			first.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "not-file" } });
	});

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
		}, opened.context);
		await entered.promise;
		await writeFile(path.join(workspace, "stale.txt"), "external");
		release.resolve();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "changed-during-read" } });
		expect(await readFile(path.join(workspace, "stale.txt"), "utf8")).toBe("external");
	});

	it("enforces snapshot and output byte limits despite metadata underreporting", async () => {
		const file = path.join(workspace, "underreported.txt");
		await writeFile(file, "12345");
		const base = new NodeNativeFileSystem();
		const underreportedNative = nativeOverride({
			async open(pathname, options) {
				const handle = await base.open(pathname, options);
				return {
					read: handle.read.bind(handle),
					async stat(operationOptions) {
						const metadata = await handle.stat(operationOptions);
						return { ...metadata, sizeBytes: 0 };
					},
					close: handle.close.bind(handle),
				};
			},
		});
		const opened = await openRuntime([], underreportedNative);
		let transformed = false;
		await expect(opened.filesystem.mutations.run(
			await resolveTarget(opened, "underreported.txt"),
			{ createParents: false, maxSnapshotBytes: 2, maxOutputBytes: 2 },
			() => {
				transformed = true;
				return { type: "commit", bytes: bytes("x") };
			},
			opened.context,
		)).resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		expect(transformed).toBe(false);
		expect(await readFile(file, "utf8")).toBe("12345");

		const outputTarget = await resolveTarget(opened, "output-limit.txt");
		await expect(opened.filesystem.mutations.overwrite(
			outputTarget,
			bytes("123"),
			{ createParents: false, maxSnapshotBytes: 2, maxOutputBytes: 2 },
			opened.context,
		)).resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		await expect(readFile(path.join(workspace, "output-limit.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("validates transform bytes and rechecks live existence and read failures", async () => {
		const opened = await openRuntime();
		const invalidTarget = await resolveTarget(opened, "invalid-transform.txt");
		const invalidTransform = { type: "commit" as const, bytes: bytes("valid") };
		Reflect.set(invalidTransform, "bytes", "invalid");
		await expect(opened.filesystem.mutations.run(
			invalidTarget,
			{ createParents: false },
			() => invalidTransform,
			opened.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "invalid-path" } });

		await writeFile(path.join(workspace, "removed.txt"), "before");
		const removedTarget = await resolveTarget(opened, "removed.txt");
		await expect(opened.filesystem.mutations.run(
			removedTarget,
			{ createParents: false },
			async () => {
				await rm(path.join(workspace, "removed.txt"));
				return { type: "commit", bytes: bytes("unsafe") };
			},
			opened.context,
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
		await expect(liveReadOpen.filesystem.mutations.overwrite(
			await resolveTarget(liveReadOpen, "live-read.txt"),
			bytes("unsafe"),
			{ createParents: false },
			liveReadOpen.context,
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
		const liveAbortOpen = await openRuntime([], liveAbortNative);
		await expect(liveAbortOpen.filesystem.mutations.overwrite(
			await resolveTarget(liveAbortOpen, "live-abort.txt"),
			bytes("unsafe"),
			{ createParents: false },
			{ signal: finalReadAbort.signal },
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it.skipIf(process.platform === "win32")("rejects a blocked destination introduced during transform", async () => {
		const protectedDirectory = path.join(temp.path, "transform-protected");
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
		}, opened.context);
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
		}, opened.context);
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

	it.skipIf(process.platform === "win32")("rechecks a queued target after it becomes a blocked symlink", async () => {
		const protectedDirectory = path.join(temp.path, "protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		await writeFile(path.join(workspace, "queued.txt"), "safe");
		const opened = await openRuntime([`${protectedDirectory}/`]);
		const target = await resolveTarget(opened, "queued.txt");
		const entered = deferred();
		const release = deferred();
		const active = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "reject", reason: "no-op" };
		}, opened.context);
		await entered.promise;
		const queued = opened.filesystem.mutations.overwrite(target, bytes("unsafe"), { createParents: false }, opened.context);
		await rm(path.join(workspace, "queued.txt"));
		await symlink(protectedFile, path.join(workspace, "queued.txt"));
		release.resolve();
		expect(expectOk(await active)).toMatchObject({ committed: false });
		await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "blocked" } });
		expect(await readFile(protectedFile, "utf8")).toBe("secret");
	});

	it.skipIf(process.platform === "win32")("replaces rather than follows a final symlink introduced after validation", async () => {
		const protectedDirectory = path.join(temp.path, "commit-race-protected");
		const protectedFile = path.join(protectedDirectory, "secret.txt");
		const racedFile = path.join(workspace, "commit-race.txt");
		await mkdir(protectedDirectory);
		await writeFile(protectedFile, "secret");
		await writeFile(racedFile, "safe");
		const base = new NodeNativeFileSystem();
		const racingNative = nativeOverride({
			async atomicReplace(file, value, options) {
				await base.atomicReplace(file, value, {
					...options,
					beforeCommit: async () => {
						await options?.beforeCommit?.();
						await rm(racedFile);
						await symlink(protectedFile, racedFile);
					},
				});
			},
		});
		const opened = await openRuntime([`${protectedDirectory}${path.sep}`], racingNative);
		const result = expectOk(await opened.filesystem.mutations.overwrite(
			await resolveTarget(opened, "commit-race.txt"),
			bytes("replacement"),
			{ createParents: false },
			opened.context,
		));
		expect(result).toMatchObject({ created: false });
		expect(await readFile(protectedFile, "utf8")).toBe("secret");
		expect(await readFile(racedFile, "utf8")).toBe("replacement");
	});

	it.skipIf(process.platform === "win32")("serializes stale refs that freshly converge on one canonical target", async () => {
		const one = path.join(workspace, "one-key.txt");
		const two = path.join(workspace, "two-key.txt");
		const shared = path.join(workspace, "shared-key.txt");
		const firstLink = path.join(workspace, "first-key.txt");
		const secondLink = path.join(workspace, "second-key.txt");
		await writeFile(one, "one");
		await writeFile(two, "two");
		await writeFile(shared, "shared");
		await symlink(one, firstLink);
		await symlink(two, secondLink);
		const opened = await openRuntime();
		const first = await resolveTarget(opened, "first-key.txt");
		const second = await resolveTarget(opened, "second-key.txt");
		await rm(firstLink);
		await rm(secondLink);
		await symlink(shared, firstLink);
		await symlink(shared, secondLink);
		let active = 0;
		let maxActive = 0;
		const transform = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active -= 1;
			return { type: "commit" as const, bytes: bytes("updated") };
		};
		const results = await Promise.all([
			opened.filesystem.mutations.run(first, { createParents: false }, transform, opened.context),
			opened.filesystem.mutations.run(second, { createParents: false }, transform, opened.context),
		]);
		for (const result of results) expect(expectOk(result)).toMatchObject({ committed: true });
		expect(maxActive).toBe(1);
		expect(await readFile(shared, "utf8")).toBe("updated");
	});

	it("runs the commit observer before the target queue admits the next transform", async () => {
		const events: string[] = [];
		const runtime = track(new FileSystemRuntime());
		const opened = expectOk(await runtime.open({
			cwd: workspace,
			policy: policy(),
			onCommitted() { events.push("observed"); },
		}));
		const target = await resolveTarget(opened, "observer-order.txt");
		const entered = deferred();
		const release = deferred();
		const first = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			events.push("first-transform");
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("first") };
		}, opened.context);
		await entered.promise;
		const second = opened.filesystem.mutations.run(target, { createParents: false }, () => {
			events.push("second-transform");
			return { type: "commit", bytes: bytes("second") };
		}, opened.context);
		release.resolve();
		expect(expectOk(await first)).toMatchObject({ committed: true });
		expect(expectOk(await second)).toMatchObject({ committed: true });
		expect(events).toEqual(["first-transform", "observed", "second-transform", "observed"]);
	});

	it("cleans the temporary file when cancelled after final validation", async () => {
		const file = path.join(workspace, "cancel-temp.txt");
		await writeFile(file, "before");
		const controller = new AbortController();
		const base = new NodeNativeFileSystem();
		const cancellingNative = nativeOverride({
			async atomicReplace(destination, value, options) {
				await base.atomicReplace(destination, value, {
					...options,
					beforeCommit: async () => {
						await options?.beforeCommit?.();
						controller.abort("cancel before rename");
					},
				});
			},
		});
		const opened = await openRuntime([], cancellingNative);
		await expect(opened.filesystem.mutations.overwrite(
			await resolveTarget(opened, "cancel-temp.txt"),
			bytes("unsafe"),
			{ createParents: false },
			{ signal: controller.signal },
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await readFile(file, "utf8")).toBe("before");
		expect((await readdir(workspace)).filter((name) => name.startsWith(".pi-") && name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("preserves an existing file mode across mutation commit", async () => {
		const file = path.join(workspace, "mode.txt");
		await writeFile(file, "before");
		await chmod(file, 0o640);
		const opened = await openRuntime();
		expect(expectOk(await opened.filesystem.mutations.overwrite(
			await resolveTarget(opened, "mode.txt"),
			bytes("after"),
			{ createParents: false },
			opened.context,
		))).toMatchObject({ created: false });
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
		expect(expectOk(await observerOpen.filesystem.mutations.overwrite(
			observedTarget,
			bytes("observed"),
			{ createParents: false },
			observerOpen.context,
		))).toMatchObject({ created: true });
		expect(await readFile(path.join(workspace, "observed.txt"), "utf8")).toBe("observed");

		const failingNative = nativeOverride({
			async atomicReplace(file) { throw new NativeFileSystemError("access-denied", "atomic-replace", file); },
		});
		const failedOpen = await openRuntime([], failingNative);
		const failedTarget = await resolveTarget(failedOpen, "failed.txt");
		await expect(failedOpen.filesystem.mutations.overwrite(
			failedTarget,
			bytes("no"),
			{ createParents: false },
			failedOpen.context,
		)).resolves.toMatchObject({ ok: false, error: { code: "write-failed" } });

		const controller = new AbortController();
		const committingNative = nativeOverride({
			async atomicReplace(file, value, options) {
				await new NodeNativeFileSystem().atomicReplace(file, value, options);
				controller.abort();
			},
		});
		const committedOpen = await openRuntime([], committingNative);
		const committedTarget = await resolveTarget(committedOpen, "committed.txt");
		const committed = await committedOpen.filesystem.mutations.overwrite(
			committedTarget,
			bytes("yes"),
			{ createParents: false },
			{ signal: controller.signal },
		);
		expect(expectOk(committed)).toMatchObject({ hash: contentHash(bytes("yes")) });
		expect(await readFile(path.join(workspace, "committed.txt"), "utf8")).toBe("yes");
	});

	it("aborts queued calls during idempotent runtime and workspace disposal", async () => {
		const runtime = track(new FileSystemRuntime());
		const opened = expectOk(await runtime.open({ cwd: workspace, policy: policy() }));
		const target = await resolveTarget(opened, "dispose.txt");
		const entered = deferred();
		const release = deferred();
		const active = opened.filesystem.mutations.run(target, { createParents: false }, async () => {
			entered.resolve();
			await release.promise;
			return { type: "commit", bytes: bytes("active") };
		}, opened.context);
		await entered.promise;
		const queued = opened.filesystem.mutations.overwrite(target, bytes("queued"), { createParents: false }, opened.context);
		runtime.dispose();
		runtime.dispose();
		await expect(queued).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		release.resolve();
		await expect(active).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(opened.disposed).toBe(true);
		opened.dispose();
		await expect(runtime.open({ cwd: workspace, policy: policy() })).resolves.toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});
});

async function openRuntime(blockedPaths: readonly string[] = [], native?: NativeFileSystem): Promise<WorkspaceFileSystemLease> {
	const runtime = track(new FileSystemRuntime(native === undefined ? {} : { native }));
	return expectOk(await runtime.open({ cwd: workspace, policy: policy(blockedPaths) }));
}

function policy(blockedPaths: readonly string[] = []): FilesystemPolicy {
	const visibility = createVisibilityPolicy();
	return { blockedPaths, visibility, fingerprint: JSON.stringify({ blockedPaths, visibility: visibility.fingerprint }) };
}

async function resolveTarget(opened: WorkspaceFileSystemLease, input: string): Promise<TargetRef> {
	return expectOk(await opened.filesystem.paths.resolveTarget(input, { followExistingSymlink: true }, opened.context));
}

function expectOk<T>(result: FsResult<T>): T {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function deferred() {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => { resolver = resolve; });
	return { promise, resolve: () => { resolver?.(); } };
}

function track(runtime: FileSystemRuntime): FileSystemRuntime {
	runtimes.push(runtime);
	return runtime;
}

function nativeOverride(overrides: Partial<Pick<NativeFileSystem, "atomicReplace" | "mkdir" | "open">>): NativeFileSystem {
	const base = new NodeNativeFileSystem();
	return {
		lstat: (file, options) => base.lstat(file, options),
		stat: (file, options) => base.stat(file, options),
		realpath: (file, options) => base.realpath(file, options),
		readdir: (directory, options) => base.readdir(directory, options),
		readlink: (file, options) => base.readlink(file, options),
		read: (file, options) => base.read(file, options),
		open: overrides.open ?? ((file, options) => base.open(file, options)),
		atomicReplace: overrides.atomicReplace ?? ((file, value, options) => base.atomicReplace(file, value, options)),
		mkdir: overrides.mkdir ?? ((directory, options) => base.mkdir(directory, options)),
	};
}
