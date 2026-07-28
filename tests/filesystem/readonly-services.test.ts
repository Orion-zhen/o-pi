import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { NativeFileSystemError, NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { collectAsync, expectFsOk, openReadonly } from "./fixtures.js";
import { wrapNative } from "./readonly-fixtures.js";

const temp = useTempDir("o-pi-readonly-fs-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem metadata, traversal and catalog services", () => {
	it.skipIf(process.platform === "win32")("lists and stats guarded entries while preserving symlinks and stable order", async () => {
		await writeFile(path.join(workspace, "b.txt"), "b");
		await writeFile(path.join(workspace, "a.txt"), "a");
		await writeFile(path.join(workspace, "secret.txt"), "secret");
		await symlink("a.txt", path.join(workspace, "link.txt"));
		const opened = await openReadonly(workspace, { blockedPaths: ["secret.txt"] });
		const listed = expectFsOk(await opened.services.metadata.list(opened.namespace.root, {}));
		const file = listed.find((entry) => entry.name === "a.txt")?.ref;
		const link = listed.find((entry) => entry.name === "link.txt")?.ref;
		if (file === undefined || link === undefined) throw new Error("Expected listed refs.");
		expect(expectFsOk(await opened.services.metadata.stat(file, {}))).toMatchObject({ kind: "file", sizeBytes: 1 });
		expect(expectFsOk(await opened.services.metadata.stat(link, {}))).toMatchObject({ kind: "symlink" });
		expect(listed.map((entry) => ({ name: entry.name, kind: entry.ref.kind, target: entry.linkTarget }))).toEqual([
			{ name: "a.txt", kind: "file", target: undefined },
			{ name: "b.txt", kind: "file", target: undefined },
			{ name: "link.txt", kind: "symlink", target: "a.txt" },
		]);
		await rm(path.join(workspace, "a.txt"));
		expect(await opened.services.metadata.stat(file, {})).toMatchObject({ ok: false, error: { code: "not-found" } });
		const controller = new AbortController();
		controller.abort("stop");
		expect(await opened.services.metadata.list(opened.namespace.root, { signal: controller.signal })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});

	it.skipIf(process.platform === "win32")("walks deterministically, prunes visibility, skips blocked paths and never follows child symlinks", async () => {
		await mkdir(path.join(workspace, "a-dir"));
		await writeFile(path.join(workspace, "a-dir", "a.txt"), "a");
		await symlink("..", path.join(workspace, "a-dir", "cycle"), "dir");
		await writeFile(path.join(workspace, "b.txt"), "b");
		await mkdir(path.join(workspace, "cache"));
		await writeFile(path.join(workspace, "cache", "drop.txt"), "drop");
		await writeFile(path.join(workspace, "cache", "keep.txt"), "keep");
		await mkdir(path.join(workspace, "ignored"));
		await writeFile(path.join(workspace, "ignored", "hidden.txt"), "hidden");
		await mkdir(path.join(workspace, "secret"));
		await writeFile(path.join(workspace, "secret", "key.txt"), "key");
		await writeFile(path.join(workspace, ".piignore"), "cache/*\n!cache/keep.txt\nignored/\n");
		const opened = await openReadonly(workspace, { blockedPaths: ["secret/"] });
		const traversal = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			includeRoot: true,
			maxEntries: 100,
		}, {}));
		const events = await collectAsync(traversal);

		expect(events.filter((event) => event.type === "entry").map((event) => event.ref.displayPath)).toEqual([
			".", ".piignore", "a-dir", "a-dir/a.txt", "b.txt", "cache", "cache/keep.txt",
		]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: "entry",
				ref: expect.objectContaining({ displayPath: "b.txt" }),
				metadata: expect.objectContaining({ kind: "file", sizeBytes: 1, version: expect.any(String) }),
			}),
			expect.objectContaining({ type: "skip", path: "a-dir/cycle", reason: "symlink" }),
			expect.objectContaining({ type: "skip", path: "cache/drop.txt", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "ignored", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "secret", reason: "blocked" }),
		]));
	});

	it("bypasses visibility below an explicitly selected ignored root and skips it otherwise", async () => {
		await mkdir(path.join(workspace, "ignored"));
		await writeFile(path.join(workspace, "ignored", "visible-by-scope.txt"), "x");
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		const opened = await openReadonly(workspace);
		const ignored = expectFsOk(await opened.namespace.paths.resolveExisting(
			"ignored",
			{ expected: "directory", followFinalSymlink: true },
			{},
		));
		if (ignored.kind !== "directory") throw new Error("Expected directory ref.");
		const skipped = expectFsOk(await opened.services.traversal.walk(ignored, { intent: "search" }, {}));
		const skippedEvents = await collectAsync(skipped);
		expect(skippedEvents).toEqual([{ type: "skip", path: "ignored", reason: "ignored", kind: "directory" }]);

		const traversal = expectFsOk(await opened.services.traversal.walk(ignored, {
			intent: "search",
			explicitRoot: true,
		}, {}));
		const paths = (await collectAsync(traversal))
			.filter((event) => event.type === "entry")
			.map((event) => event.ref.displayPath);
		expect(paths).toEqual(["ignored/visible-by-scope.txt"]);
	});

	it("reports local access errors, caller limits and cancellation without corrupting later traversals", async () => {
		await mkdir(path.join(workspace, "denied"));
		await writeFile(path.join(workspace, "denied", "x.txt"), "x");
		await writeFile(path.join(workspace, "broken.txt"), "broken");
		await writeFile(path.join(workspace, "later.txt"), "later");
		const base = new NodeNativeFileSystem();
		const native = wrapNative(base, {
			lstat(pathname) {
				if (pathname.endsWith(`${path.sep}broken.txt`)) {
					throw new NativeFileSystemError("access-denied", "lstat", pathname);
				}
			},
			readdir(pathname) {
				if (pathname.endsWith(`${path.sep}denied`)) {
					throw new NativeFileSystemError("access-denied", "readdir", pathname);
				}
			},
		});
		const opened = await openReadonly(workspace, { native });
		const partial = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 100,
		}, {}));
		const partialEvents = await collectAsync(partial);
		expect(partialEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "error", path: "broken.txt", error: expect.objectContaining({ code: "access-denied" }) }),
			expect.objectContaining({ type: "error", path: "denied", error: expect.objectContaining({ code: "access-denied" }) }),
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "later.txt" }) }),
		]));

		const limited = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 1,
		}, {}));
		const limitedEvents = await collectAsync(limited);
		expect(limitedEvents.at(-1)).toMatchObject({ type: "skip", reason: "entry-limit" });

		const controller = new AbortController();
		const cancelled = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, {
			intent: "search",
			maxEntries: 100,
		}, { signal: controller.signal }));
		const cancelledEvents = [];
		for await (const event of cancelled) {
			cancelledEvents.push(event);
			if (event.type === "entry") controller.abort("stop");
		}
		expect(cancelledEvents.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
	});

	it("returns a root operation failure when the root cannot be enumerated", async () => {
		const base = new NodeNativeFileSystem();
		const native = wrapNative(base, {
			readdir(pathname) {
				if (pathname === workspace) throw new NativeFileSystemError("access-denied", "readdir", pathname);
			},
		});
		const opened = await openReadonly(workspace, { native });
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, {})).toMatchObject({
			ok: false,
			error: { code: "access-denied", path: "." },
		});
	});

	it("validates traversal and catalog controls at their public boundaries", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		const opened = await openReadonly(workspace);
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search", maxEntries: -1 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search", maxDepth: -1 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		const depthLimited = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, { intent: "search", maxDepth: 1 }, {}));
		const depthEvents = await collectAsync(depthLimited);
		expect(depthEvents).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "src" }), depth: 1 }),
			expect.objectContaining({ type: "skip", path: "src", reason: "depth-limit" }),
		]));
		expect(depthEvents).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "src/a.ts" }) }),
		]));
		const controller = new AbortController();
		controller.abort("stop");
		expect(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, { signal: controller.signal })).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
		expect(await opened.services.catalog.suggest(opened.namespace.root, "a", { limit: -1, maxEntries: 10 }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		expect(expectFsOk(await opened.services.catalog.suggest(opened.namespace.root, "a", { limit: 0, maxEntries: 10 }, {}))).toEqual([]);
		expect(await opened.services.catalog.suggest(
			opened.namespace.root,
			"a",
			{ limit: 1, maxEntries: 10 },
			{ signal: controller.signal },
		)).toMatchObject({ ok: false, error: { code: "aborted" } });
		const directories = expectFsOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"src",
			{ limit: 2, maxEntries: 10, kinds: ["directory"] },
			{},
		));
		expect(directories).toEqual([expect.objectContaining({ ref: expect.objectContaining({ displayPath: "src", kind: "directory" }) })]);
		const reusable = expectFsOk(await opened.services.traversal.walk(opened.namespace.root, { intent: "search" }, {}));
		await collectAsync(reusable);
		const repeated = await collectAsync(reusable);
		expect(repeated).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "invalid-path" }) })]);
	});

	it("ranks typo suggestions deterministically and filters invisible or unrelated paths", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "main.ts"), "main");
		await writeFile(path.join(workspace, "src", "main.test.ts"), "test");
		await writeFile(path.join(workspace, "src", "hidden.ts"), "hidden");
		await writeFile(path.join(workspace, ".piignore"), "src/hidden.ts\n");
		const opened = await openReadonly(workspace);
		const suggestions = expectFsOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"src/maim.ts",
			{ limit: 3, maxEntries: 100 },
			{},
		));
		expect(suggestions[0]).toMatchObject({ ref: { displayPath: "src/main.ts", kind: "file" } });
		expect(suggestions.every((candidate) => candidate.ref.displayPath !== "src/hidden.ts")).toBe(true);
		expect(expectFsOk(await opened.services.catalog.suggest(
			opened.namespace.root,
			"zzz_totally_unrelated_abc.txt",
			{ limit: 3, maxEntries: 100 },
			{},
		))).toEqual([]);
	});
});
