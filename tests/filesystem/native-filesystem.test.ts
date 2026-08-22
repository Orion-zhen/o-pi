import { chmod, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-native-fs-");
let root: string;
let native: NodeNativeFileSystem;

beforeEach(() => {
	root = temp.path;
	native = new NodeNativeFileSystem();
});

describe("NodeNativeFileSystem", () => {
	it("provides metadata, directory, link, read, no-follow open and mkdir primitives", async () => {
		const nested = path.join(root, "nested");
		const file = path.join(nested, "a.txt");
		await native.mkdir(nested);
		await native.atomicReplace(file, Buffer.from("hello"), { beforeCommit: async () => undefined });

		expect(await native.lstat(file)).toMatchObject({ kind: "file", sizeBytes: 5 });
		expect(await native.stat(file)).toMatchObject({ kind: "file", sizeBytes: 5 });
		expect(await native.realpath(file)).toBe(file);
		expect(await native.readdir(nested)).toEqual([{ name: "a.txt", kind: "file" }]);
		expect(Buffer.from(await native.read(file)).toString("utf8")).toBe("hello");

		const handle = await native.open(file);
		try {
			const buffer = new Uint8Array(3);
			expect(await handle.read(buffer, 0, 3, 1)).toBe(3);
			expect(Buffer.from(buffer).toString("utf8")).toBe("ell");
			expect(handle.metadata).toMatchObject({ kind: "file", sizeBytes: 5 });
		} finally {
			await handle.close();
		}

		if (process.platform !== "win32") {
			const link = path.join(nested, "link.txt");
			await symlink("a.txt", link);
			expect(await native.lstat(link)).toMatchObject({ kind: "symlink" });
			expect(await native.readlink(link)).toBe("a.txt");
		}
	});

	it("supports recursive mkdir and maps missing paths and cancellation", async () => {
		const nested = path.join(root, "a", "b");
		await native.mkdir(nested, { recursive: true });
		await writeFile(path.join(nested, "x"), "x");
		await expect(native.read(path.join(root, "missing"))).rejects.toMatchObject({
			name: "NativeFileSystemError",
			code: "not-found",
			operation: "read",
		});

		const controller = new AbortController();
		controller.abort("test");
		await expect(native.lstat(root, { signal: controller.signal })).rejects.toMatchObject({
			code: "aborted",
		});

		const inFlightController = new AbortController();
		const inFlight = native.realpath(root, { signal: inFlightController.signal });
		inFlightController.abort("in-flight");
		await expect(inFlight).rejects.toMatchObject({ code: "aborted" });
	});

	it.skipIf(process.platform === "win32")("does not follow a final symlink when opening", async () => {
		const target = path.join(root, "target.txt");
		const link = path.join(root, "link.txt");
		await writeFile(target, "secret");
		await symlink(target, link);
		await expect(native.open(link)).rejects.toMatchObject({ code: "changed", operation: "open" });
	});

	it("atomically replaces only after validation and cleans temporary files on failure or cancellation", async () => {
		const file = path.join(root, "atomic.txt");
		await writeFile(file, "before");
		let observedBeforeCommit = false;
		const commitResult = await native.atomicReplace(file, Buffer.from("after"), {
			async beforeCommit() {
				observedBeforeCommit = true;
				expect(await new NodeNativeFileSystem().read(file)).toEqual(Buffer.from("before"));
				return "validated";
			},
		});
		expect(commitResult).toBe("validated");
		expect(observedBeforeCommit).toBe(true);
		expect(Buffer.from(await native.read(file)).toString("utf8")).toBe("after");

		await expect(native.atomicReplace(file, Buffer.from("unsafe"), {
			async beforeCommit() { throw new Error("validation failed"); },
		})).rejects.toMatchObject({ code: "io-error" });
		expect(Buffer.from(await native.read(file)).toString("utf8")).toBe("after");

		const controller = new AbortController();
		await expect(native.atomicReplace(file, Buffer.from("cancelled"), {
			signal: controller.signal,
			async beforeCommit() { controller.abort("stop"); },
		})).rejects.toMatchObject({ code: "aborted" });
		expect(Buffer.from(await native.read(file)).toString("utf8")).toBe("after");
		expect((await readdir(root)).filter((name) => name.startsWith(".pi-") && name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("preserves the requested mode during atomic replacement", async () => {
		const file = path.join(root, "mode.txt");
		await writeFile(file, "before");
		await chmod(file, 0o640);
		const mode = (await stat(file)).mode & 0o7777;
		await native.atomicReplace(file, Buffer.from("after"), { mode, beforeCommit: async () => undefined });
		expect((await stat(file)).mode & 0o7777).toBe(mode);
	});

	it.skipIf(process.platform === "win32")("normalizes common Node errno values", async () => {
		const file = path.join(root, "file.txt");
		await writeFile(file, "x");
		await expect(native.readdir(path.join(file, "child"))).rejects.toMatchObject({ code: "not-directory" });
		await expect(native.read(root)).rejects.toMatchObject({ code: "is-directory" });
		await expect(native.mkdir(root)).rejects.toMatchObject({ code: "already-exists" });
		await expect(native.readlink(file)).rejects.toMatchObject({ code: "invalid-path" });
		await expect(native.lstat(path.join(root, "x".repeat(300)))).rejects.toMatchObject({ code: "invalid-path" });
	});

});
