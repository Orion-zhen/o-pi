import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { FileRef, TargetRef } from "../../src/filesystem/contracts/path.js";
import type { FilesystemPolicy } from "../../src/filesystem/contracts/policy.js";
import { FileSystemRuntime, type WorkspaceFileSystemLease } from "../../src/filesystem/runtime.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeOpenFile,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { deferredVoid } from "../helpers/async.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	collectAsync,
	expectFsOk,
	overrideNativeFileSystem,
	textBytes,
} from "./fixtures.js";

const temp = useTempDir("o-pi-lease-context-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("workspace lease operation context", () => {
	it("关闭 lease 会取消进行中的读取并关闭文件 handle", async () => {
		await writeFile(path.join(workspace, "active.txt"), "active");
		const base = new NodeNativeFileSystem();
		const started = deferredVoid();
		let closed = 0;
		const native = overrideNativeFileSystem({
			async open(pathname, options) {
				const handle = await base.open(pathname, options);
				return delayedReadHandle(handle, pathname, started, () => { closed += 1; });
			},
		}, base);
		const runtime = new FileSystemRuntime({ native });
		try {
			const lease = await openLease(runtime);
			const file = await resolveFile(lease, "active.txt");
			const pending = lease.filesystem.content.readBytes(file, {});
			await started.promise;
			lease.dispose();
			await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
			expect(closed).toBe(1);
		} finally {
			runtime.dispose();
		}
	});

	it("关闭 lease 会取消进行中的遍历", async () => {
		await mkdir(path.join(workspace, "nested"));
		await writeFile(path.join(workspace, "nested", "file.txt"), "content");
		const base = new NodeNativeFileSystem();
		const started = deferredVoid();
		const nested = path.join(workspace, "nested");
		const native = overrideNativeFileSystem({
			async readdir(pathname, options) {
				if (pathname === nested) {
					started.resolve();
					await rejectWhenAborted(options?.signal, "readdir", pathname);
				}
				return await base.readdir(pathname, options);
			},
		}, base);
		const runtime = new FileSystemRuntime({ native });
		try {
			const lease = await openLease(runtime);
			const traversal = expectFsOk(await lease.filesystem.discovery.discover(lease.filesystem.root, {}));
			const pending = collectAsync(traversal);
			await started.promise;
			lease.dispose();
			const events = await pending;
			expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
		} finally {
			runtime.dispose();
		}
	});

	it("关闭 lease 会取消进行中的增量可见性规则加载", async () => {
		await writeFile(path.join(workspace, ".piignore"), "hidden.txt\n");
		await writeFile(path.join(workspace, "hidden.txt"), "hidden");
		const base = new NodeNativeFileSystem();
		const started = deferredVoid();
		const ignorePath = path.join(workspace, ".piignore");
		const native = overrideNativeFileSystem({
			async read(pathname, options) {
				if (pathname === ignorePath) {
					started.resolve();
					await rejectWhenAborted(options?.signal, "read", pathname);
				}
				return await base.read(pathname, options);
			},
		}, base);
		const runtime = new FileSystemRuntime({ native });
		try {
			const lease = await openLease(runtime);
			const file = await resolveFile(lease, "hidden.txt");
			const pending = lease.filesystem.visibility.evaluate(file, "search");
			await started.promise;
			lease.dispose();
			await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		} finally {
			runtime.dispose();
		}
	});

	it("关闭 lease 会取消 mutation wait 并在活动任务退出后释放队列", async () => {
		const runtime = new FileSystemRuntime();
		try {
			const lease = await openLease(runtime);
			const target = await resolveTarget(lease, "queued.txt");
			const entered = deferredVoid();
			const release = deferredVoid();
			const active = lease.filesystem.mutations.run(target, { createParents: false }, async () => {
				entered.resolve();
				await release.promise;
				return { type: "commit", prepared: undefined, bytes: textBytes("active") };
			});
			await entered.promise;
			const waiting = lease.filesystem.mutations.run(
				target,
				{ createParents: false },
				() => ({ type: "commit", prepared: undefined, bytes: textBytes("waiting") }),
			);
			lease.dispose();
			await expect(waiting).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
			release.resolve();
			await expect(active).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });

			const nextLease = await openLease(runtime);
			const nextTarget = await resolveTarget(nextLease, "queued.txt");
			expect(expectFsOk(await nextLease.filesystem.mutations.run(
				nextTarget,
				{ createParents: false },
				() => ({ type: "commit", prepared: undefined, bytes: textBytes("next") }),
			))).toMatchObject({ committed: true });
		} finally {
			runtime.dispose();
		}
	});
});

function policy(): FilesystemPolicy {
	const visibility = createVisibilityPolicy({ ignore: { builtinProfile: "none" } });
	return { blockedPaths: [], visibility, fingerprint: visibility.fingerprint };
}

async function openLease(runtime: FileSystemRuntime): Promise<WorkspaceFileSystemLease> {
	return expectFsOk(await runtime.open({ cwd: workspace, policy: policy() }));
}

async function resolveFile(lease: WorkspaceFileSystemLease, input: string): Promise<FileRef> {
	const ref = expectFsOk(await lease.filesystem.paths.resolveExisting(input, {
		expected: "file",
		followFinalSymlink: true,
	}));
	return ref;
}

async function resolveTarget(lease: WorkspaceFileSystemLease, input: string): Promise<TargetRef> {
	return expectFsOk(await lease.filesystem.paths.resolveTarget(input));
}

function delayedReadHandle(
	handle: NativeOpenFile,
	pathname: string,
	started: ReturnType<typeof deferredVoid>,
	onClose: () => void,
): NativeOpenFile {
	return {
		metadata: handle.metadata,
		async read(_buffer, _offset, _length, _position, options) {
			started.resolve();
			return await rejectWhenAborted(options?.signal, "read", pathname);
		},
		async close() {
			onClose();
			await handle.close();
		},
	};
}

async function rejectWhenAborted(
	signal: AbortSignal | undefined,
	operation: string,
	pathname: string,
): Promise<never> {
	if (signal?.aborted === true) throw new NativeFileSystemError("aborted", operation, pathname);
	if (signal === undefined) throw new Error("Expected a lease-bound abort signal.");
	await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	throw new NativeFileSystemError("aborted", operation, pathname);
}
