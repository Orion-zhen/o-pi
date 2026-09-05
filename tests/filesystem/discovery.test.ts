import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { DiscoveryEvent } from "../../src/filesystem/contracts/discovery.js";
import type { DirectoryRef, FileRef } from "../../src/filesystem/contracts/path.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import type { ReadonlyFileSystemServices } from "../../src/filesystem/services/readonly.js";
import { useTempDir } from "../helpers/lifecycle.js";
import {
	collectAsync,
	expectFsOk,
	openReadonly,
	overrideNativeFileSystem,
	type OpenedReadonly,
} from "./fixtures.js";

const temp = useTempDir("o-pi-discovery-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe.each(["discover", "discoverPaths"] as const)("filesystem %s boundaries", (method) => {
	it.skipIf(process.platform === "win32")("保持顺序、剪枝和访问边界，且不跟随子符号链接", async () => {
		for (const directory of ["a-dir", "cache", "ignored", "secret"]) await mkdir(path.join(workspace, directory));
		for (const file of ["a-dir/a.txt", "b.txt", "cache/drop.txt", "cache/keep.txt", "ignored/hidden.txt", "secret/key.txt"]) {
			await writeFile(path.join(workspace, file), "x");
		}
		await symlink("..", path.join(workspace, "a-dir/cycle"), "dir");
		await writeFile(path.join(workspace, ".piignore"), "cache/*\n!cache/keep.txt\nignored/\n");
		const opened = await openReadonly(workspace, { blockedPaths: ["secret/"] });
		const stream = expectFsOk(await opened.services.discovery[method](opened.namespace.root, { maxEntries: 100 }));
		const events = await collectAsync(stream);
		expect(events.filter((event) => event.type === "entry").map((event) => event.ref.displayPath)).toEqual([
			".piignore", "a-dir", "b.txt", "cache", "a-dir/a.txt", "cache/keep.txt",
		]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "skip", path: "a-dir/cycle", reason: "symlink" }),
			expect.objectContaining({ type: "skip", path: "cache/drop.txt", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "ignored", reason: "ignored" }),
			expect.objectContaining({ type: "skip", path: "secret", reason: "blocked" }),
		]));
		const file = events.find((event) => event.type === "entry" && event.ref.displayPath === "b.txt");
		if (method === "discover") expect(file).toMatchObject({ snapshot: { sizeBytes: 1, version: expect.any(String) } });
		else expect(file).not.toHaveProperty("snapshot");
	});

	it("自动发现跳过忽略目录，显式根可穿过软忽略", async () => {
		await mkdir(path.join(workspace, "ignored"));
		await writeFile(path.join(workspace, "ignored/explicit.txt"), "x");
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		const opened = await openReadonly(workspace);
		const implicit = await collectAsync(expectFsOk(await opened.services.discovery[method](opened.namespace.root, {})));
		expect(implicit.filter((event) => event.type === "skip")).toEqual([
			{ type: "skip", path: "ignored", reason: "ignored", kind: "directory" },
		]);
		const root = await opened.resolveDirectory("ignored");
		const explicit = await collectAsync(expectFsOk(await opened.services.discovery[method](root, {})));
		expect(explicit.filter((event) => event.type === "entry").map((event) => event.ref.displayPath)).toEqual(["ignored/explicit.txt"]);
	});

	it("保留目录局部错误与根错误，扫描数量限制不破坏后续发现", async () => {
		await mkdir(path.join(workspace, "denied"));
		await writeFile(path.join(workspace, "denied/x.txt"), "x");
		await writeFile(path.join(workspace, "later.txt"), "later");
		const base = new NodeNativeFileSystem();
		let denyRoot = false;
		const native = overrideNativeFileSystem({
			async readdir(pathname, context) {
				if (pathname === path.join(workspace, "denied") || (denyRoot && pathname === workspace)) {
					throw new NativeFileSystemError("access-denied", "readdir", pathname);
				}
				return base.readdir(pathname, context);
			},
		}, base);
		const opened = await openReadonly(workspace, { native });
		const partial = await collectAsync(expectFsOk(await opened.services.discovery[method](opened.namespace.root, {})));
		expect(partial).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "error", path: "denied", error: expect.objectContaining({ code: "access-denied" }) }),
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "later.txt" }) }),
		]));
		const limited = await collectAsync(expectFsOk(await opened.services.discovery[method](opened.namespace.root, { maxEntries: 1 })));
		expect(limited.at(-1)).toMatchObject({ type: "skip", reason: "entry-limit" });
		denyRoot = true;
		expect(await opened.services.discovery[method](opened.namespace.root, {})).toMatchObject({ ok: false, error: { code: "access-denied", path: "." } });
	});

	it("保持深度、静态前缀、单次消费、提前关闭和取消语义", async () => {
		await mkdir(path.join(workspace, "src/nested"), { recursive: true });
		await writeFile(path.join(workspace, "src/nested/a.ts"), "a");
		const owner = new AbortController();
		const opened = await openReadonly(workspace, { ownerSignal: owner.signal });
		const limited = await collectAsync(expectFsOk(await opened.services.discovery[method](opened.namespace.root, { maxDepth: 1 })));
		expect(limited).toEqual([
			expect.objectContaining({ type: "entry", ref: expect.objectContaining({ displayPath: "src" }), depth: 1 }),
			expect.objectContaining({ type: "skip", path: "src", reason: "depth-limit" }),
		]);
		const prefix = expectFsOk(await opened.services.discovery[method](opened.namespace.root, { glob: "src/**/*.ts" }));
		expect(await collectAsync(prefix)).toEqual([
			expect.objectContaining({ type: "entry", relativePath: "src/nested/a.ts", depth: 3 }),
		]);
		expect(await collectAsync(prefix)).toEqual([]);
		const closed = expectFsOk(await opened.services.discovery[method](opened.namespace.root, {}));
		await closed.close();
		expect(await collectAsync(closed)).toEqual([]);
		const early = expectFsOk(await opened.services.discovery[method](opened.namespace.root, {}));
		for await (const _event of early) break;
		expect(await collectAsync(early)).toEqual([]);
		const canceled = expectFsOk(await opened.services.discovery[method](opened.namespace.root, {}));
		const events = [];
		for await (const event of canceled) {
			events.push(event);
			if (event.type === "entry") owner.abort();
		}
		expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
		expect(await opened.services.discovery[method](opened.namespace.root, {})).toMatchObject({ ok: false, error: { code: "aborted" } });
	});
});

describe("filesystem discovery", () => {
	it.each([
		"/src/*.ts",
		"../src/*.ts",
		"src/../*.ts",
		"C:/src/*.ts",
	] as const)("拒绝越出 root 的 glob：%s", async (glob) => {
		const opened = await openReadonly(workspace);
		expect(await opened.services.discovery.discover(opened.namespace.root, { glob })).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
	});

	it("递归匹配 basename，返回稳定顺序、原始深度和 snapshot", async () => {
		await mkdir(path.join(workspace, "docs"));
		await mkdir(path.join(workspace, "src", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "docs", "c.ts"), "c");
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		await writeFile(path.join(workspace, "src", "deep", "b.ts"), "b");
		await writeFile(path.join(workspace, "src", "deep", "skip.js"), "skip");
		const opened = await openReadonly(workspace);

		const events = await discover(opened, opened.namespace.root, { glob: "*.ts" });
		const entries = events.filter((event) => event.type === "entry");
		expect(entries.map((event) => event.relativePath)).toEqual(["docs/c.ts", "src/a.ts", "src/deep/b.ts"]);
		expect(entries.map((event) => event.depth)).toEqual([2, 2, 3]);
		expect(entries).toEqual(entries.map(() => expect.objectContaining({
			type: "entry",
			ref: expect.objectContaining({}),
			snapshot: expect.objectContaining({
				identity: expect.any(String),
				version: expect.any(String),
				sizeBytes: 1,
			}),
			visibility: expect.objectContaining({ ignored: false }),
		})));
	});

	it("从静态目录前缀开始遍历，不遍历无关目录", async () => {
		await mkdir(path.join(workspace, "src", "deep"), { recursive: true });
		await mkdir(path.join(workspace, "other"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		await writeFile(path.join(workspace, "src", "deep", "b.ts"), "b");
		await writeFile(path.join(workspace, "other", "c.ts"), "c");
		const reads: string[] = [];
		const opened = await openReadonly(workspace, { native: observeReaddir(new NodeNativeFileSystem(), reads) });
		reads.length = 0;

		const matched = await discover(opened, opened.namespace.root, { glob: "src/**/*.ts" });
		expect(entryPaths(matched)).toEqual(["src/a.ts", "src/deep/b.ts"]);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((pathname) =>
			pathname === workspace || pathname.startsWith(path.join(workspace, "src")))).toBe(true);
		expect(reads).not.toContain(path.join(workspace, "other"));

		reads.length = 0;
		const missing = await discover(opened, opened.namespace.root, { glob: "missing/**/*.ts" });
		expect(missing).toEqual([]);
		expect(reads).toEqual([]);
	});

	it("目录 glob 的尾随 slash 按目录类型匹配", async () => {
		await mkdir(path.join(workspace, "packages", "api"), { recursive: true });
		await mkdir(path.join(workspace, "packages", "web"), { recursive: true });
		await writeFile(path.join(workspace, "packages", "note.txt"), "note");
		const opened = await openReadonly(workspace);

		const events = await discover(opened, opened.namespace.root, { glob: "packages/*/" });
		expect(entryPaths(events)).toEqual(["packages/api", "packages/web"]);
	});

	it("文件 root 只以 basename 匹配且不扩大范围", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		const opened = await openReadonly(workspace);
		const file = await opened.resolveFile("src/a.ts");
		expect(entryPaths(await discover(opened, file, { glob: "*.ts" }))).toEqual(["a.ts"]);
		expect(await discover(opened, file, { glob: "src/*.ts" })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("显式文件 symlink 可跟随，目录 child symlink 不跟随", async () => {
		await writeFile(path.join(workspace, "real.ts"), "real");
		await symlink("real.ts", path.join(workspace, "alias.ts"));
		const opened = await openReadonly(workspace);
		const alias = await opened.resolveFile("alias.ts");
		expect(entryPaths(await discover(opened, alias, {}))).toEqual(["alias.ts"]);

		const events = await discover(opened, opened.namespace.root, {});
		expect(entryPaths(events)).toEqual(["real.ts"]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "skip", path: "alias.ts", reason: "symlink" }),
		]));
	});

	it("静态前缀保留固定的显式 ignored root bypass", async () => {
		await mkdir(path.join(workspace, "ignored", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "ignored", "deep", "explicit.ts"), "ignored");
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		const opened = await openReadonly(workspace);
		const ignored = await opened.resolveDirectory("ignored");

		const explicit = await discover(opened, ignored, { glob: "deep/*.ts" });
		expect(entryPaths(explicit)).toEqual(["deep/explicit.ts"]);
		const selectedPrefix = await discover(opened, opened.namespace.root, {
			glob: "ignored/**/*.ts",
		});
		expect(entryPaths(selectedPrefix)).toEqual(["ignored/deep/explicit.ts"]);
	});

	it("静态前缀不重置深度限制", async () => {
		await mkdir(path.join(workspace, "src", "nested", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "src", "one.ts"), "one");
		await writeFile(path.join(workspace, "src", "nested", "two.ts"), "two");
		await writeFile(path.join(workspace, "src", "nested", "deep", "three.ts"), "three");
		const opened = await openReadonly(workspace);

		const events = await discover(opened, opened.namespace.root, {
			glob: "src/**/*.ts",
			maxDepth: 2,
		});
		expect(entryPaths(events)).toEqual(["src/one.ts"]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "skip", reason: "depth-limit" }),
		]));
	});

	it.skipIf(process.platform === "win32")("剪枝遇到 child symlink 时返回 skip 且不跟随", async () => {
		await mkdir(path.join(workspace, "real"));
		await writeFile(path.join(workspace, "real", "x.ts"), "x");
		await symlink("real", path.join(workspace, "linked"), "dir");
		const opened = await openReadonly(workspace);
		const events = await discover(opened, opened.namespace.root, { glob: "linked/**/*.ts" });
		expect(events).toEqual([expect.objectContaining({ type: "skip", path: "linked", reason: "symlink" })]);
	});

	it("保留局部错误、支持取消，并在 close 或提前退出后停止流", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		await writeFile(path.join(workspace, "broken.txt"), "broken");
		await writeFile(path.join(workspace, "z.txt"), "z");
		const base = new NodeNativeFileSystem();
		const brokenPath = path.join(workspace, "broken.txt");
		const opened = await openReadonly(workspace, { native: overrideLstat(base, brokenPath) });

		const partial = await discover(opened, opened.namespace.root, {});
		expect(entryPaths(partial)).toEqual(["a.txt", "z.txt"]);
		expect(partial).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "error", path: "broken.txt", error: expect.objectContaining({ code: "access-denied" }) }),
		]));

		const controller = new AbortController();
		const cancelledOpened = await openReadonly(workspace, {
			native: overrideLstat(base, brokenPath),
			ownerSignal: controller.signal,
		});
		const cancelled = expectFsOk(await cancelledOpened.services.discovery.discover(
			cancelledOpened.namespace.root,
			{},
		));
		const cancelledEvents: DiscoveryEvent[] = [];
		for await (const event of cancelled) {
			cancelledEvents.push(event);
			if (event.type === "entry") controller.abort("stop");
		}
		expect(cancelledEvents.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });

		const closed = expectFsOk(await opened.services.discovery.discover(opened.namespace.root, {}));
		await closed.close();
		expect(await collectAsync(closed)).toEqual([]);

		const early = expectFsOk(await opened.services.discovery.discover(opened.namespace.root, {}));
		for await (const _event of early) break;
		expect(await collectAsync(early)).toEqual([]);
	});

	it("将活动 discovery 绑定到 readonly owner signal", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		const owner = new AbortController();
		const opened = await openReadonly(workspace, { ownerSignal: owner.signal });
		const stream = expectFsOk(await opened.services.discovery.discover(opened.namespace.root, {}));
		owner.abort("lease closed");
		expect(await collectAsync(stream)).toEqual([
			expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "aborted" }) }),
		]);
		expect(await opened.services.discovery.discover(opened.namespace.root, {})).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});

	it("让显式文件的 entry limit 零开销结束", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		const opened = await openReadonly(workspace);
		const file = await opened.resolveFile("a.txt");
		expect(await discover(opened, file, { maxEntries: 0 })).toEqual([
			expect.objectContaining({ type: "skip", reason: "entry-limit" }),
		]);
	});
});

async function discover(
	opened: OpenedReadonly,
	root: FileRef | DirectoryRef,
	options: Parameters<ReadonlyFileSystemServices["discovery"]["discover"]>[1],
): Promise<DiscoveryEvent[]> {
	const stream = expectFsOk(await opened.services.discovery.discover(root, options));
	return await collectAsync(stream);
}

function entryPaths(events: readonly DiscoveryEvent[]): string[] {
	return events.filter((event) => event.type === "entry").map((event) => event.relativePath);
}

function observeReaddir(base: NativeFileSystem, reads: string[]): NativeFileSystem {
	return overrideNativeFileSystem({
		async readdir(pathname, options) {
			reads.push(pathname);
			return await base.readdir(pathname, options);
		},
	}, base);
}

function overrideLstat(base: NativeFileSystem, deniedPath: string): NativeFileSystem {
	return overrideNativeFileSystem({
		async lstat(pathname, options) {
			if (pathname === deniedPath) throw new NativeFileSystemError("access-denied", "lstat", pathname);
			return await base.lstat(pathname, options);
		},
	}, base);
}
