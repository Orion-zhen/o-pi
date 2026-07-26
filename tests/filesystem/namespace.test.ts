import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { FsResult } from "../../src/filesystem/contracts/result.js";
import { pathMatchesRule, WorkspaceAccessPolicy } from "../../src/filesystem/kernel/access-policy.js";
import { preflightWriteAccess } from "../../src/filesystem/kernel/access-preflight.js";
import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-namespace-");
let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
	root = temp.path;
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	await mkdir(workspace);
	await mkdir(outside);
});

describe("workspace namespace", () => {
	it("rejects missing or non-directory workspace roots", async () => {
		const fileRoot = path.join(root, "workspace-file");
		await writeFile(fileRoot, "x");
		expect(await createWorkspaceNamespace({ workspaceRoot: fileRoot, blockedPaths: [] })).toMatchObject({
			ok: false,
			error: { code: "not-directory", path: "." },
		});
		expect(await createWorkspaceNamespace({ workspaceRoot: path.join(root, "missing-root"), blockedPaths: [] })).toMatchObject({
			ok: false,
			error: { code: "not-found", path: "." },
		});
	});

	it("normalizes workspace, absolute, parent-relative and home paths without restricting outside access", async () => {
		await writeFile(path.join(workspace, "inside.txt"), "inside");
		await writeFile(path.join(outside, "outside.txt"), "outside");
		const namespace = await openNamespace({ homeDirectory: outside });

		const inside = expectOk(await namespace.paths.resolveExisting(
			path.join(workspace, "inside.txt"),
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(inside).toMatchObject({ kind: "file", displayPath: "inside.txt", workspacePath: "inside.txt" });

		const relativeOutside = path.relative(workspace, path.join(outside, "outside.txt"));
		const parentRelative = expectOk(await namespace.paths.resolveExisting(
			relativeOutside,
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(parentRelative.displayPath).toBe(relativeOutside.replaceAll("\\", "/"));
		expect(parentRelative.workspacePath).toBeUndefined();

		const absoluteOutside = expectOk(await namespace.paths.resolveExisting(
			path.join(outside, "outside.txt"),
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(absoluteOutside.displayPath).toBe(path.join(outside, "outside.txt"));

		const home = expectOk(await namespace.paths.resolveExisting(
			"~/outside.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(home.displayPath).toBe(path.join(outside, "outside.txt"));
	});

	it.each(["", "bad\0path", "skill://resource"])("rejects invalid path %j before native I/O", async (input) => {
		const namespace = await openNamespace();
		const result = await namespace.paths.resolveExisting(input, { expected: "any", followFinalSymlink: true }, {});
		expect(result).toMatchObject({ ok: false, error: { code: "invalid-path", path: input } });
	});

	it.skipIf(process.platform === "win32")("keeps lexical workspace display when realpath uses a different spelling", async () => {
		const realWorkspace = path.join(root, "real-workspace");
		const lexicalWorkspace = path.join(root, "lexical-workspace");
		await mkdir(realWorkspace);
		await writeFile(path.join(realWorkspace, "a.txt"), "a");
		await symlink(realWorkspace, lexicalWorkspace, "dir");
		const opened = expectOk(await createWorkspaceNamespace({ workspaceRoot: lexicalWorkspace, blockedPaths: [] }));
		const file = expectOk(await opened.paths.resolveExisting(
			path.join(lexicalWorkspace, "a.txt"),
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(opened.root.displayPath).toBe(".");
		expect(file).toMatchObject({ displayPath: "a.txt", workspacePath: "a.txt" });
		expect(opened.bridge.getNativeIdentity(file)?.canonicalPath).toBe(path.join(realWorkspace, "a.txt"));
	});

	it("enforces lexical blocked rules and preserves directory trailing-slash semantics", async () => {
		await mkdir(path.join(workspace, "secret"));
		await writeFile(path.join(workspace, "secret", "key.txt"), "key");
		const directoryRule = await openNamespace({ blockedPaths: ["secret/"] });
		expect(await directoryRule.paths.resolveExisting(
			"secret/key.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({
			ok: false,
			error: { code: "blocked", path: "secret/key.txt", details: { matchedRule: "secret/", phase: "lexical" } },
		});

		const exactRule = await openNamespace({ blockedPaths: ["secret"] });
		expect(await exactRule.paths.resolveExisting(
			"secret/key.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: true });
		expect(pathMatchesRule(
			{ displayPath: "secret", absolutePath: path.join(workspace, "secret"), workspacePath: "secret" },
			"secret",
		)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("blocks canonical targets reached through an explicit symlink", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "secret.txt"), "secret");
		await symlink(path.join(protectedDir, "secret.txt"), path.join(workspace, "secret-link.txt"));
		const namespace = await openNamespace({ blockedPaths: [`${protectedDir}${path.sep}`] });
		const result = await namespace.paths.resolveExisting(
			"secret-link.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "blocked", path: "secret-link.txt", details: { phase: "canonical", matchedPath: path.join(protectedDir, "secret.txt") } },
		});
	});

	it.skipIf(process.platform === "win32")("checks existing target and nearest parent symlinks for writes", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "target.txt"), "secret");
		await symlink(path.join(protectedDir, "target.txt"), path.join(workspace, "target-link.txt"));
		await symlink(protectedDir, path.join(workspace, "parent-link"), "dir");
		const namespace = await openNamespace({ blockedPaths: [`${protectedDir}${path.sep}`] });

		expect(await namespace.paths.resolveTarget("target-link.txt", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "canonical" } },
		});
		expect(await namespace.paths.resolveTarget("parent-link/new/file.txt", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "parent", matchedPath: protectedDir } },
		});
	});

	it.skipIf(process.platform === "win32")("guards and resolves dangling write symlinks through their nearest target parent", async () => {
		const allowedLink = path.join(workspace, "allowed-link.txt");
		const blockedLink = path.join(workspace, "blocked-link.txt");
		const allowedTarget = path.join(outside, "allowed.txt");
		const protectedDir = path.join(outside, "protected-dangling");
		const intermediateLink = path.join(outside, "intermediate-link.txt");
		await mkdir(protectedDir);
		await symlink(allowedTarget, allowedLink);
		await symlink(path.join(protectedDir, "blocked.txt"), intermediateLink);
		await symlink(intermediateLink, blockedLink);

		const namespace = await openNamespace({ blockedPaths: [`${protectedDir}${path.sep}`] });
		const danglingRef = expectOk(await namespace.paths.resolveExisting(
			"allowed-link.txt",
			{ expected: "any", followFinalSymlink: false },
			{},
		));
		expect(danglingRef.kind).toBe("symlink");
		const preserved = expectOk(await namespace.paths.resolveTarget("allowed-link.txt", { followExistingSymlink: false }, {}));
		expect(preserved.existingKind).toBe("symlink");
		const allowed = expectOk(await namespace.paths.resolveTarget("allowed-link.txt", { followExistingSymlink: true }, {}));
		expect(allowed.existingKind).toBeUndefined();
		expect(namespace.bridge.getNativeIdentity(allowed)?.nativePath).toBe(allowedTarget);
		expect(await namespace.paths.resolveTarget("blocked-link.txt", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "parent", matchedPath: protectedDir } },
		});
	});

	it.skipIf(process.platform === "win32")("makes final-symlink following explicit for existing refs and targets", async () => {
		const target = path.join(workspace, "target.txt");
		const link = path.join(workspace, "link.txt");
		await writeFile(target, "target");
		await symlink(target, link);
		const namespace = await openNamespace();

		const preserved = expectOk(await namespace.paths.resolveExisting(
			"link.txt",
			{ expected: "any", followFinalSymlink: false },
			{},
		));
		expect(preserved.kind).toBe("symlink");
		expect(namespace.bridge.getNativeIdentity(preserved)?.nativePath).toBe(link);
		const followed = expectOk(await namespace.paths.resolveExisting(
			"link.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(followed.kind).toBe("file");
		expect(namespace.bridge.getNativeIdentity(followed)?.nativePath).toBe(target);

		const preservedTarget = expectOk(await namespace.paths.resolveTarget("link.txt", { followExistingSymlink: false }, {}));
		expect(preservedTarget.existingKind).toBe("symlink");
		expect(namespace.bridge.getNativeIdentity(preservedTarget)?.nativePath).toBe(link);
		const followedTarget = expectOk(await namespace.paths.resolveTarget("link.txt", { followExistingSymlink: true }, {}));
		expect(followedTarget.existingKind).toBe("file");
		expect(namespace.bridge.getNativeIdentity(followedTarget)?.nativePath).toBe(target);
	});

	it("provides a lightweight write preflight without exposing native identities", async () => {
		const result = await preflightWriteAccess({
			cwd: workspace,
			path: "new/file.txt",
			blockedPaths: [],
			homeDirectory: outside,
			native: new NodeNativeFileSystem(),
			context: {},
		});
		expect(result).toEqual({ ok: true, value: { displayPath: "new/file.txt", workspacePath: "new/file.txt" } });
	});

	it("validates expected kinds and canonical containment", async () => {
		await mkdir(path.join(workspace, "dir"));
		await writeFile(path.join(workspace, "dir", "file.txt"), "x");
		await writeFile(path.join(outside, "outside.txt"), "x");
		const namespace = await openNamespace();
		expect(await namespace.paths.resolveExisting(
			"dir",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "not-file" } });
		expect(await namespace.paths.resolveExisting(
			"missing",
			{ expected: "any", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "not-found" } });
		expect(await namespace.paths.resolveTarget("", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		const directory = expectOk(await namespace.paths.resolveExisting(
			"dir",
			{ expected: "directory", followFinalSymlink: true },
			{},
		));
		if (directory.kind !== "directory") throw new Error("Expected directory ref");
		const inside = expectOk(await namespace.paths.resolveExisting(
			"dir/file.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		const external = expectOk(await namespace.paths.resolveExisting(
			path.join(outside, "outside.txt"),
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(namespace.paths.isWithin(directory, inside)).toBe(true);
		expect(namespace.paths.isWithin(directory, external)).toBe(false);
		const otherNamespace = await openNamespace();
		const otherExternal = expectOk(await otherNamespace.paths.resolveExisting(
			path.join(outside, "outside.txt"),
			{ expected: "file", followFinalSymlink: true },
			{},
		));
		expect(namespace.paths.isWithin(directory, otherExternal)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("hydrates a dangling-link destination that appears during resolution", async () => {
		const destination = path.join(outside, "appeared.txt");
		const link = path.join(workspace, "appeared-link.txt");
		await writeFile(destination, "appeared");
		await symlink(destination, link);
		const base = new NodeNativeFileSystem();
		let injectedMissing = false;
		const native: NativeFileSystem = {
			lstat: base.lstat.bind(base),
			stat: base.stat.bind(base),
			realpath: async (file, options) => {
				if (file === link && !injectedMissing) {
					injectedMissing = true;
					throw new NativeFileSystemError("not-found", "realpath", file);
				}
				return base.realpath(file, options);
			},
			readdir: base.readdir.bind(base),
			readlink: base.readlink.bind(base),
			read: base.read.bind(base),
			open: base.open.bind(base),
			atomicReplace: base.atomicReplace.bind(base),
			mkdir: base.mkdir.bind(base),
		};
		const namespace = await openNamespace({ native });
		const target = expectOk(await namespace.paths.resolveTarget("appeared-link.txt", { followExistingSymlink: true }, {}));
		expect(target.existingKind).toBe("file");
		expect(namespace.bridge.getNativeIdentity(target)?.nativePath).toBe(destination);
	});

	it.skipIf(process.platform === "win32")("rechecks the canonical identity after an injected lstat/realpath race", async () => {
		const protectedDir = path.join(outside, "race-protected");
		const protectedFile = path.join(protectedDir, "secret.txt");
		const racedPath = path.join(workspace, "raced.txt");
		await mkdir(protectedDir);
		await writeFile(protectedFile, "secret");
		await writeFile(racedPath, "initial");
		const base = new NodeNativeFileSystem();
		let replaced = false;
		const native: NativeFileSystem = {
			lstat: async (file, options) => {
				const metadata = await base.lstat(file, options);
				if (file === racedPath && !replaced) {
					replaced = true;
					await rm(racedPath);
					await symlink(protectedFile, racedPath);
				}
				return metadata;
			},
			stat: base.stat.bind(base),
			realpath: base.realpath.bind(base),
			readdir: base.readdir.bind(base),
			readlink: base.readlink.bind(base),
			read: base.read.bind(base),
			open: base.open.bind(base),
			atomicReplace: base.atomicReplace.bind(base),
			mkdir: base.mkdir.bind(base),
		};
		const namespace = await openNamespace({ blockedPaths: [`${protectedDir}${path.sep}`], native });
		expect(await namespace.paths.resolveExisting(
			"raced.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "blocked", details: { phase: "canonical" } } });
	});

	it("creates an opaque other ref when the backend reports a non-file entry", async () => {
		const unusualPath = path.join(workspace, "unusual");
		await writeFile(unusualPath, "x");
		const base = new NodeNativeFileSystem();
		const baseMetadata = await base.lstat(unusualPath);
		const otherMetadata = { ...baseMetadata, kind: "other" as const, modifiedAtMs: 0 };
		const native: NativeFileSystem = {
			lstat: async (file, options) => file === unusualPath ? otherMetadata : base.lstat(file, options),
			stat: async (file, options) => file === unusualPath ? otherMetadata : base.stat(file, options),
			realpath: base.realpath.bind(base),
			readdir: base.readdir.bind(base),
			readlink: base.readlink.bind(base),
			read: base.read.bind(base),
			open: base.open.bind(base),
			atomicReplace: base.atomicReplace.bind(base),
			mkdir: base.mkdir.bind(base),
		};
		const namespace = await openNamespace({ native });
		expect(expectOk(await namespace.paths.resolveExisting(
			"unusual",
			{ expected: "any", followFinalSymlink: true },
			{},
		)).kind).toBe("other");
	});

	it("maps injected permission errors and honors cancellation", async () => {
		await writeFile(path.join(workspace, "denied.txt"), "x");
		await writeFile(path.join(workspace, "invalid.txt"), "x");
		await writeFile(path.join(workspace, "stat-denied.txt"), "x");
		await writeFile(path.join(workspace, "unknown-error.txt"), "x");
		const base = new NodeNativeFileSystem();
		const deniedPath = path.join(workspace, "denied.txt");
		const invalidPath = path.join(workspace, "invalid.txt");
		const statDeniedPath = path.join(workspace, "stat-denied.txt");
		const unknownErrorPath = path.join(workspace, "unknown-error.txt");
		const native: NativeFileSystem = {
			lstat: async (file, options) => {
				if (file === deniedPath) throw new NativeFileSystemError("access-denied", "lstat", file);
				if (file === invalidPath) throw new NativeFileSystemError("invalid-path", "lstat", file);
				if (file === unknownErrorPath) throw new Error("injected unknown error");
				return base.lstat(file, options);
			},
			stat: async (file, options) => {
				if (file === statDeniedPath) throw new NativeFileSystemError("access-denied", "stat", file);
				return base.stat(file, options);
			},
			realpath: base.realpath.bind(base),
			readdir: base.readdir.bind(base),
			readlink: base.readlink.bind(base),
			read: base.read.bind(base),
			open: base.open.bind(base),
			atomicReplace: base.atomicReplace.bind(base),
			mkdir: base.mkdir.bind(base),
		};
		const namespace = await openNamespace({ native });
		expect(await namespace.paths.resolveExisting(
			"denied.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied", path: "denied.txt" } });
		expect(await namespace.paths.resolveExisting(
			"invalid.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "invalid-path", path: "invalid.txt" } });
		expect(await namespace.paths.resolveExisting(
			"unknown-error.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied", path: "unknown-error.txt" } });
		expect(await namespace.paths.resolveExisting(
			"stat-denied.txt",
			{ expected: "file", followFinalSymlink: true },
			{},
		)).toMatchObject({ ok: false, error: { code: "access-denied", path: "stat-denied.txt" } });
		expect(await namespace.paths.resolveTarget("stat-denied.txt", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "access-denied", path: "stat-denied.txt" },
		});
		expect(await namespace.paths.resolveTarget("invalid.txt", { followExistingSymlink: true }, {})).toMatchObject({
			ok: false,
			error: { code: "invalid-path", path: "invalid.txt" },
		});

		const controller = new AbortController();
		controller.abort();
		expect(await namespace.paths.resolveExisting(
			".",
			{ expected: "directory", followFinalSymlink: true },
			{ signal: controller.signal },
		)).toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("exposes matched rule detail from the access policy", () => {
		const policy = new WorkspaceAccessPolicy({ blockedPaths: ["private/"] });
		expect(policy.match("private/a", {
			displayPath: "private/a",
			absolutePath: path.join(workspace, "private", "a"),
			workspacePath: "private/a",
		}, "lexical")).toMatchObject({
			code: "BLOCKED_PATH",
			matchedRule: "private/",
			phase: "lexical",
		});
	});
});

async function openNamespace(options: {
	readonly blockedPaths?: readonly string[];
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
} = {}): Promise<WorkspaceNamespaceKernel> {
	return expectOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: options.blockedPaths ?? [],
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		...(options.native === undefined ? {} : { native: options.native }),
	}));
}

function expectOk<T>(result: FsResult<T>): T {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error(`Expected success, received ${result.error.code}`);
	return result.value;
}
