import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Discovery, DiscoveryEvent } from "../../src/filesystem/contracts/discovery.js";
import type { DirectoryRef, FileRef } from "../../src/filesystem/contracts/path.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import type { VisibilityPolicy } from "../../src/filesystem/contracts/visibility.js";
import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import {
	createReadonlyFileSystemServices,
	type ReadonlyFileSystemServices,
} from "../../src/filesystem/services/readonly.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-discovery-");
let workspace: string;

beforeEach(async () => {
	workspace = path.join(temp.path, "workspace");
	await mkdir(workspace);
});

describe("filesystem discovery", () => {
	it.each([
		"/src/*.ts",
		"../src/*.ts",
		"src/../*.ts",
		"C:/src/*.ts",
		"src/\0*.ts",
	] as const)("拒绝越出 root 的 glob：%s", async (glob) => {
		const opened = await openReadonly();
		expect(await opened.services.discovery.discover(opened.namespace.root, { intent: "search", glob }, {})).toMatchObject({
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
		const opened = await openReadonly();

		const events = await discover(opened, opened.namespace.root, { glob: "*.ts", kind: "file" });
		const entries = events.filter((event) => event.type === "entry");
		expect(entries.map((event) => event.relativePath)).toEqual(["docs/c.ts", "src/a.ts", "src/deep/b.ts"]);
		expect(entries.map((event) => event.depth)).toEqual([2, 2, 3]);
		expect(entries).toEqual(entries.map(() => expect.objectContaining({
			type: "entry",
			ref: expect.objectContaining({ kind: "file" }),
			snapshot: expect.objectContaining({
				identity: expect.any(String),
				version: expect.any(String),
				sizeBytes: 1,
			}),
			visibility: expect.objectContaining({ ignored: false }),
		})));
	});

	it("从静态目录前缀开始遍历，缺失前缀不枚举 root", async () => {
		await mkdir(path.join(workspace, "src", "deep"), { recursive: true });
		await mkdir(path.join(workspace, "other"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		await writeFile(path.join(workspace, "src", "deep", "b.ts"), "b");
		await writeFile(path.join(workspace, "other", "c.ts"), "c");
		const reads: string[] = [];
		const opened = await openReadonly({ native: observeReaddir(new NodeNativeFileSystem(), reads) });
		reads.length = 0;

		const matched = await discover(opened, opened.namespace.root, { glob: "src/**/*.ts", kind: "file" });
		expect(entryPaths(matched)).toEqual(["src/a.ts", "src/deep/b.ts"]);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((pathname) => pathname.startsWith(path.join(workspace, "src")))).toBe(true);

		reads.length = 0;
		const missing = await discover(opened, opened.namespace.root, { glob: "missing/**/*.ts", kind: "file" });
		expect(missing).toEqual([]);
		expect(reads).toEqual([]);
	});

	it("文件 root 只以 basename 匹配且不扩大范围", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "a");
		const opened = await openReadonly();
		const file = await resolveFile(opened.namespace, "src/a.ts");
		expect(entryPaths(await discover(opened, file, { glob: "*.ts", kind: "file" }))).toEqual(["a.ts"]);
		expect(await discover(opened, file, { glob: "src/*.ts", kind: "file" })).toEqual([]);
		expect(await discover(opened, file, { kind: "directory" })).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("显式文件 symlink 可跟随，目录 child symlink 不跟随", async () => {
		await writeFile(path.join(workspace, "real.ts"), "real");
		await symlink("real.ts", path.join(workspace, "alias.ts"));
		const opened = await openReadonly();
		const alias = await resolveFile(opened.namespace, "alias.ts");
		expect(entryPaths(await discover(opened, alias, { kind: "file" }))).toEqual(["alias.ts"]);

		const events = await discover(opened, opened.namespace.root, { kind: "file" });
		expect(entryPaths(events)).toEqual(["real.ts"]);
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "skip", path: "alias.ts", reason: "symlink" }),
		]));
	});

	it("静态前缀保留显式 ignored root bypass", async () => {
		await mkdir(path.join(workspace, "ignored", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "ignored", "deep", "explicit.ts"), "ignored");
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		const opened = await openReadonly();
		const ignored = await resolveDirectory(opened.namespace, "ignored");

		expect(await discover(opened, ignored, { glob: "deep/*.ts", kind: "file" })).toEqual([
			expect.objectContaining({ type: "skip", path: "ignored", reason: "ignored" }),
		]);
		const explicit = await discover(opened, ignored, { glob: "deep/*.ts", kind: "file", explicitRoot: true });
		expect(entryPaths(explicit)).toEqual(["deep/explicit.ts"]);
	});

	it("静态前缀不重置深度限制", async () => {
		await mkdir(path.join(workspace, "src", "nested", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "src", "one.ts"), "one");
		await writeFile(path.join(workspace, "src", "nested", "two.ts"), "two");
		await writeFile(path.join(workspace, "src", "nested", "deep", "three.ts"), "three");
		const opened = await openReadonly();

		const events = await discover(opened, opened.namespace.root, {
			glob: "src/**/*.ts",
			kind: "file",
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
		const opened = await openReadonly();
		const events = await discover(opened, opened.namespace.root, { glob: "linked/**/*.ts", kind: "file" });
		expect(events).toEqual([expect.objectContaining({ type: "skip", path: "linked", reason: "symlink" })]);
	});

	it("保留局部错误、支持取消，并在 close 或提前退出后停止流", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		await writeFile(path.join(workspace, "broken.txt"), "broken");
		await writeFile(path.join(workspace, "z.txt"), "z");
		const base = new NodeNativeFileSystem();
		const brokenPath = path.join(workspace, "broken.txt");
		const opened = await openReadonly({ native: overrideLstat(base, brokenPath) });

		const partial = await discover(opened, opened.namespace.root, { kind: "file" });
		expect(entryPaths(partial)).toEqual(["a.txt", "z.txt"]);
		expect(partial).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "error", path: "broken.txt", error: expect.objectContaining({ code: "access-denied" }) }),
		]));

		const controller = new AbortController();
		const cancelled = expectOk(await opened.services.discovery.discover(
			opened.namespace.root,
			{ intent: "search", kind: "file" },
			{ signal: controller.signal },
		));
		const cancelledEvents: DiscoveryEvent[] = [];
		for await (const event of cancelled) {
			cancelledEvents.push(event);
			if (event.type === "entry") controller.abort("stop");
		}
		expect(cancelledEvents.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });

		const closed = expectOk(await opened.services.discovery.discover(opened.namespace.root, { intent: "search" }, {}));
		await closed.close();
		expect(await collect(closed)).toEqual([]);

		const early = expectOk(await opened.services.discovery.discover(opened.namespace.root, { intent: "search" }, {}));
		for await (const _event of early) break;
		expect(await collect(early)).toEqual([
			expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "invalid-path" }) }),
		]);
	});

	it("将活动 discovery 绑定到 readonly owner signal", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		const owner = new AbortController();
		const opened = await openReadonly({ ownerSignal: owner.signal });
		const stream = expectOk(await opened.services.discovery.discover(opened.namespace.root, { intent: "search" }, {}));
		owner.abort("lease closed");
		expect(await collect(stream)).toEqual([
			expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "aborted" }) }),
		]);
		expect(await opened.services.discovery.discover(opened.namespace.root, { intent: "search" }, {})).toMatchObject({
			ok: false,
			error: { code: "aborted" },
		});
	});

	it("在公开边界验证 limit，并让显式文件的 entry limit 零开销结束", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a");
		const opened = await openReadonly();
		for (const options of [{ maxDepth: -1 }, { maxEntries: -1 }]) {
			expect(await opened.services.discovery.discover(opened.namespace.root, { intent: "search", ...options }, {})).toMatchObject({
				ok: false,
				error: { code: "invalid-path" },
			});
		}
		const file = await resolveFile(opened.namespace, "a.txt");
		expect(await discover(opened, file, { maxEntries: 0 })).toEqual([
			expect.objectContaining({ type: "skip", reason: "entry-limit", kind: "file" }),
		]);
	});
});

interface OpenedReadonly {
	readonly namespace: WorkspaceNamespaceKernel;
	readonly services: ReadonlyFileSystemServices;
}

async function openReadonly(options: {
	readonly native?: NativeFileSystem;
	readonly policy?: VisibilityPolicy;
	readonly ownerSignal?: AbortSignal;
} = {}): Promise<OpenedReadonly> {
	const native = options.native ?? new NodeNativeFileSystem();
	const namespace = expectOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: [],
		native,
		...(options.ownerSignal === undefined ? {} : { context: { signal: options.ownerSignal } }),
	}));
	const visibilitySnapshot = await new WorkspaceVisibilityService(native).createSnapshot(
		workspace,
		options.policy ?? createVisibilityPolicy({ ignore: { builtinProfile: "none" } }),
	);
	return {
		namespace,
		services: createReadonlyFileSystemServices({
			native,
			namespace,
			visibilitySnapshot,
			...(options.ownerSignal === undefined ? {} : { ownerSignal: options.ownerSignal }),
		}),
	};
}

async function discover(
	opened: OpenedReadonly,
	root: FileRef | DirectoryRef,
	options: Omit<Parameters<ReadonlyFileSystemServices["discovery"]["discover"]>[1], "intent">,
): Promise<DiscoveryEvent[]> {
	const stream = expectOk(await opened.services.discovery.discover(root, { intent: "search", ...options }, {}));
	return await collect(stream);
}

async function collect(stream: Discovery): Promise<DiscoveryEvent[]> {
	const events: DiscoveryEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function entryPaths(events: readonly DiscoveryEvent[]): string[] {
	return events.filter((event) => event.type === "entry").map((event) => event.relativePath);
}

async function resolveFile(namespace: WorkspaceNamespaceKernel, input: string): Promise<FileRef> {
	const ref = expectOk(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }, {}));
	if (ref.kind !== "file") throw new Error(`Expected file ref for ${input}.`);
	return ref;
}

async function resolveDirectory(namespace: WorkspaceNamespaceKernel, input: string): Promise<DirectoryRef> {
	const ref = expectOk(await namespace.paths.resolveExisting(input, { expected: "directory", followFinalSymlink: true }, {}));
	if (ref.kind !== "directory") throw new Error(`Expected directory ref for ${input}.`);
	return ref;
}

function expectOk<T>(result: FsResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function observeReaddir(base: NativeFileSystem, reads: string[]): NativeFileSystem {
	return wrapNative(base, {
		readdir(pathname) { reads.push(pathname); },
	});
}

function overrideLstat(base: NativeFileSystem, deniedPath: string): NativeFileSystem {
	return wrapNative(base, {
		lstat(pathname) {
			if (pathname === deniedPath) throw new NativeFileSystemError("access-denied", "lstat", pathname);
		},
	});
}

function wrapNative(base: NativeFileSystem, overrides: {
	readonly lstat?: (path: string) => void;
	readonly readdir?: (path: string) => void;
}): NativeFileSystem {
	return {
		async lstat(pathname, options) {
			overrides.lstat?.(pathname);
			return await base.lstat(pathname, options);
		},
		stat: (pathname, options) => base.stat(pathname, options),
		realpath: (pathname, options) => base.realpath(pathname, options),
		async readdir(pathname, options) {
			overrides.readdir?.(pathname);
			return await base.readdir(pathname, options);
		},
		readlink: (pathname, options) => base.readlink(pathname, options),
		read: (pathname, options) => base.read(pathname, options),
		open: (pathname, options) => base.open(pathname, options),
		atomicReplace: (pathname, bytes, options) => base.atomicReplace(pathname, bytes, options),
		mkdir: (pathname, options) => base.mkdir(pathname, options),
	};
}
