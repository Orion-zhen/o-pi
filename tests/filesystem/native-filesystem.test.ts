import { symlink, writeFile } from "node:fs/promises";
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
	it("provides the narrow metadata, directory, link, read, open, write and mkdir primitives", async () => {
		const nested = path.join(root, "nested");
		const file = path.join(nested, "a.txt");
		await native.mkdir(nested);
		await native.write(file, Buffer.from("hello"));

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
			expect(await handle.stat()).toMatchObject({ kind: "file", sizeBytes: 5 });
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
