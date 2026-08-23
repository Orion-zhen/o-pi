import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { expectFsOk as expectOk, overrideNativeFileSystem as nativeOverride, textBytes as bytes } from "./fixtures.js";
import { commitBytes, useMutationFixture } from "./mutation-fixtures.js";

const test = useMutationFixture("o-pi-mutation-runtime-");
const { commitPath, openRuntime, policy, resolveTarget, track } = test;
let workspace: string;
beforeEach(() => { workspace = test.workspace; });

describe("filesystem mutation runtime", () => {
	it("aborts a workspace while visibility is opening", async () => {
		const controller = new AbortController();
		const native = nativeOverride({
			async lstat(filePath, options) {
				if (filePath === path.join(workspace, ".git")) controller.abort();
				return await new NodeNativeFileSystem().lstat(filePath, options);
			},
		});
		const runtime = track(new FileSystemRuntime({ native }));
		await expect(runtime.open({
			cwd: workspace,
			policy: policy(),
			context: { signal: controller.signal },
		})).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});
	it("creates parents, fully overwrites files, and returns before/after versions", async () => {
		const opened = await openRuntime();
		const target = await resolveTarget(opened, "nested/file.txt");
		const firstBytes = bytes("first\n");
		const firstResult = expectOk(await commitBytes(opened, target, firstBytes, { createParents: true }));
		expect(firstResult).toMatchObject({ committed: true });
		if (!firstResult.committed) throw new Error("Expected committed mutation.");
		const first = firstResult.receipt;
		expect(first).toMatchObject({
			created: true,
			hash: contentHash(firstBytes),
			sizeBytes: firstBytes.byteLength,
			target: { displayPath: "nested/file.txt" },
		});

		const secondBytes = bytes("second\n");
		const second = expectOk(await commitBytes(opened, first.target, secondBytes, { createParents: true }));
		expect(second).toMatchObject({
			committed: true,
			receipt: {
				created: false,
				before: { hash: first.hash, sizeBytes: first.sizeBytes },
				hash: contentHash(secondBytes),
			},
		});
		expect(await readFile(path.join(workspace, "nested/file.txt"), "utf8")).toBe("second\n");
	});
	it("maps parent/read failures and aborts before transform or commit", async () => {
		const mkdirNative = nativeOverride({
			async mkdir(directory) { throw new NativeFileSystemError("access-denied", "mkdir", directory); },
		});
		const mkdirOpen = await openRuntime([], mkdirNative);
		await expect(commitBytes(
			mkdirOpen,
			await resolveTarget(mkdirOpen, "nested/fail.txt"),
			bytes("fail"),
			{ createParents: true },
		)).resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		await writeFile(path.join(workspace, "read-fail.txt"), "before");
		const readNative = nativeOverride({
			async open(file) { throw new NativeFileSystemError("access-denied", "open", file); },
		});
		const readOpen = await openRuntime([], readNative);
		await expect(commitBytes(
			readOpen,
			await resolveTarget(readOpen, "read-fail.txt"),
			bytes("fail"),
			{ createParents: false },
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
		const abortReadOpen = await openRuntime([], abortingReadNative, readAbort.signal);
		let transformed = false;
		await expect(abortReadOpen.filesystem.mutations.run(
			await resolveTarget(abortReadOpen, "abort-read.txt"),
			{ createParents: false },
			() => {
				transformed = true;
				return { type: "commit", bytes: bytes("unsafe") };
			},
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(transformed).toBe(false);

		const transformAbort = new AbortController();
		const transformAbortOpen = await openRuntime([], undefined, transformAbort.signal);
		const abortTarget = await resolveTarget(transformAbortOpen, "abort-transform.txt");
		await expect(transformAbortOpen.filesystem.mutations.run(
			abortTarget,
			{ createParents: false },
			() => {
				transformAbort.abort();
				return { type: "commit", bytes: bytes("unsafe") };
			},
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});
	it("rejects foreign refs, directories, and optimistic commits after target changes", async () => {
		const first = await openRuntime();
		const second = await openRuntime();
		const foreign = await resolveTarget(first, "foreign.txt");
		await expect(commitBytes(second, foreign, bytes("foreign"), { createParents: false }))
			.resolves.toMatchObject({ ok: false, error: { code: "invalid-path" } });

		await mkdir(path.join(workspace, "directory"));
		const directory = await resolveTarget(first, "directory");
		await expect(commitBytes(first, directory, bytes("not-file"), { createParents: false }))
			.resolves.toMatchObject({ ok: false, error: { code: "not-file" } });
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
		)).resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		expect(transformed).toBe(false);
		expect(await readFile(file, "utf8")).toBe("12345");

		await expect(commitPath(
			opened,
			"output-limit.txt",
			bytes("123"),
			{ createParents: false, maxSnapshotBytes: 2, maxOutputBytes: 2 },
		)).resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		await expect(readFile(path.join(workspace, "output-limit.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
