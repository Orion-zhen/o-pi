import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { contentHash } from "../../src/filesystem/services/text.js";
import { expectFsOk as expectOk, overrideNativeFileSystem as nativeOverride, textBytes as bytes } from "./fixtures.js";
import { commitBytes, useMutationFixture } from "./mutation-fixtures.js";
import { wrapNative } from "./readonly-fixtures.js";

const test = useMutationFixture("o-pi-mutation-runtime-");
const { openMutation, openRuntime, policy, resolveTarget, track } = test;
let workspace: string;
beforeEach(() => { workspace = test.workspace; });

describe("filesystem mutation runtime", () => {
	it.each(["commit", "reject", "too-large"] as const)("仅成功提交返回准备结果：%s", async (mode) => {
		const mutation = await openMutation("prepared.txt", { initial: "before" });
		const prepared = { operation: "test", ranges: [1, 2] };
		const result = await mutation.run<typeof prepared, string>(
			{ createParents: false, maxOutputBytes: mode === "too-large" ? 1 : 100 },
			() => mode === "reject"
				? { type: "reject", reason: "not-ready" }
				: { type: "commit", bytes: bytes("after"), prepared },
		);
		if (mode === "commit") {
			const committed = expectOk(result);
			expect(committed).toMatchObject({ committed: true, prepared });
			if (!committed.committed) throw new Error("Expected commit");
			expect(committed.prepared).toBe(prepared);
		} else {
			expect(result).toMatchObject(mode === "reject"
				? { ok: true, value: { committed: false, reason: "not-ready" } }
				: { ok: false, error: { code: "too-large" } });
			if (result.ok) expect(result.value).not.toHaveProperty("prepared");
		}
		expect(await readFile(path.join(workspace, "prepared.txt"), "utf8")).toBe(mode === "commit" ? "after" : "before");
	});

	it("修改快照读取抛出未知异常时关闭 handle，且不执行 transform", async () => {
		const tracker = { opened: 0, closed: 0 };
		const failure = new Error("unexpected snapshot failure");
		const mutation = await openMutation("unexpected.txt", {
			initial: "before",
			native: wrapNative(new NodeNativeFileSystem(), {
				tracker,
				closeError: true,
				beforeRead() { throw failure; },
			}),
		});
		let transformed = false;
		await expect(mutation.run({ createParents: false }, () => {
			transformed = true;
			return { type: "commit", prepared: undefined, bytes: bytes("unsafe") };
		})).rejects.toBe(failure);
		expect(transformed).toBe(false);
		expect(tracker).toEqual({ opened: 1, closed: 1 });
		expect(await readFile(path.join(workspace, "unexpected.txt"), "utf8")).toBe("before");
	});
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
		const mutation = await openMutation("nested/file.txt");
		const firstBytes = bytes("first\n");
		const firstResult = expectOk(await mutation.commit(firstBytes, { createParents: true }));
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
		const second = expectOk(await commitBytes(mutation.opened, first.target, secondBytes, { createParents: true }));
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
		const mkdirMutation = await openMutation("nested/fail.txt", { native: mkdirNative });
		await expect(mkdirMutation.commit(bytes("fail"), { createParents: true }))
			.resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		const readNative = nativeOverride({
			async open(file) { throw new NativeFileSystemError("access-denied", "open", file); },
		});
		const readMutation = await openMutation("read-fail.txt", { initial: "before", native: readNative });
		await expect(readMutation.commit(bytes("fail"), { createParents: false }))
			.resolves.toMatchObject({ ok: false, error: { code: "access-denied" } });

		const readAbort = new AbortController();
		const abortingReadNative = nativeOverride({
			async open(file, options) {
				const handle = await new NodeNativeFileSystem().open(file, options);
				readAbort.abort();
				return handle;
			},
		});
		const abortRead = await openMutation("abort-read.txt", { initial: "before", native: abortingReadNative, signal: readAbort.signal });
		let transformed = false;
		await expect(abortRead.run(
			{ createParents: false },
			() => {
				transformed = true;
				return { type: "commit", prepared: undefined, bytes: bytes("unsafe") };
			},
		)).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(transformed).toBe(false);

		const transformAbort = new AbortController();
		const abortTransform = await openMutation("abort-transform.txt", { signal: transformAbort.signal });
		await expect(abortTransform.run(
			{ createParents: false },
			() => {
				transformAbort.abort();
				return { type: "commit", prepared: undefined, bytes: bytes("unsafe") };
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
		const mutation = await openMutation("underreported.txt", { initial: "12345", native: underreportedNative });
		let transformed = false;
		await expect(mutation.run(
			{ createParents: false, maxSnapshotBytes: 2, maxOutputBytes: 2 },
			() => {
				transformed = true;
				return { type: "commit", prepared: undefined, bytes: bytes("x") };
			},
		)).resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		expect(transformed).toBe(false);
		expect(await readFile(file, "utf8")).toBe("12345");

		const output = await openMutation("output-limit.txt", { native: underreportedNative });
		await expect(output.commit(bytes("123"), { createParents: false, maxSnapshotBytes: 2, maxOutputBytes: 2 }))
			.resolves.toMatchObject({
			ok: false,
			error: { code: "too-large", details: { limit: 2, size: 3 } },
		});
		await expect(readFile(path.join(workspace, "output-limit.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
