import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { VisibilityService } from "../../src/filesystem/contracts/visibility.js";
import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { expectFsOk as expectOk, overrideNativeFileSystem as nativeOverride, textBytes as bytes } from "./fixtures.js";
import { useMutationFixture } from "./mutation-fixtures.js";

const test = useMutationFixture("o-pi-mutation-runtime-");
const { openRuntime, policy, resolveTarget, track } = test;
let workspace: string;
beforeEach(() => { workspace = test.workspace; });

describe("filesystem mutation runtime", () => {
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
	it("enforces snapshot and output byte limits despite metadata underreporting", async () => {
		const file = path.join(workspace, "underreported.txt");
		await writeFile(file, "12345");
		const base = new NodeNativeFileSystem();
		let openedUnderreportedFile = false;
		const underreportedNative = nativeOverride({
			async lstat(pathname, options) {
				const metadata = await base.lstat(pathname, options);
				return openedUnderreportedFile && pathname === file ? { ...metadata, sizeBytes: 0 } : metadata;
			},
			async open(pathname, options) {
				const handle = await base.open(pathname, options);
				if (pathname === file) openedUnderreportedFile = true;
				return handle;
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
});
