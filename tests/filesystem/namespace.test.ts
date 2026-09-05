import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { FilesystemPathAccess } from "../../src/filesystem/contracts/access.js";
import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import { NativeFileSystemError, NodeNativeFileSystem, type NativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk, overrideNativeFileSystem } from "./fixtures.js";

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

		const inside = await resolveFile(namespace, path.join(workspace, "inside.txt"));
		expect(inside).toMatchObject({ kind: "file", displayPath: "inside.txt", workspacePath: "inside.txt" });

		const relativeOutside = path.relative(workspace, path.join(outside, "outside.txt"));
		const parentRelative = await resolveFile(namespace, relativeOutside);
		expect(parentRelative.displayPath).toBe(relativeOutside.replaceAll("\\", "/"));
		expect(parentRelative.workspacePath).toBeUndefined();

		const absoluteOutside = await resolveFile(namespace, path.join(outside, "outside.txt"));
		expect(absoluteOutside.displayPath).toBe(path.join(outside, "outside.txt"));

		const home = await resolveFile(namespace, "~/outside.txt");
		expect(home.displayPath).toBe(path.join(outside, "outside.txt"));
	});
	it.each(["", "bad\0path", "skill://resource"])("rejects invalid path %j before native I/O", async (input) => {
		const namespace = await openNamespace();
		const result = await namespace.paths.resolveExisting(input, { expected: "any", followFinalSymlink: true });
		expect(result).toMatchObject({ ok: false, error: { code: "invalid-path", path: input } });
	});
	it.skipIf(process.platform === "win32")("mounts authorized logical roots and blocks ordinary-path aliases", async () => {
		const skillRoot = path.join(outside, "demo-skill");
		await mkdir(path.join(skillRoot, "references"), { recursive: true });
		await writeFile(path.join(skillRoot, "SKILL.md"), "skill");
		await writeFile(path.join(skillRoot, "references", "testing.md"), "testing");
		const alias = path.join(workspace, "skill-alias");
		const outsideAlias = path.join(workspace, "outside-alias");
		const removedSkillRoot = path.join(outside, "removed-skill");
		await symlink(skillRoot, alias);
		await symlink(outside, outsideAlias);
		const namespace = await openNamespace({
			pathAccess: {
				mounts: [{ logicalRoot: "skill://demo", nativeRoot: skillRoot }],
				protectedRoots: [skillRoot, removedSkillRoot],
				managedSchemes: ["skill"],
			},
		});

		const mountedRoot = await resolveDirectory(namespace, "skill://demo");
		const mountedFile = await resolveFile(namespace, "skill://demo/references/testing.md");
		expect(mountedRoot.displayPath).toBe("skill://demo");
		expect(mountedRoot.workspacePath).toBeUndefined();
		expect(mountedFile.displayPath).toBe("skill://demo/references/testing.md");
		expect(mountedFile.workspacePath).toBeUndefined();
		expect(namespace.paths.relative(mountedRoot, mountedFile)).toBe("references/testing.md");
		expect(namespace.paths.relative(namespace.root, mountedFile)).toBeUndefined();
		expect(await namespace.paths.resolveTarget(
			"skill://demo/references/new.md",
		)).toMatchObject({ ok: true, value: { displayPath: "skill://demo/references/new.md" } });
		expect(await namespace.paths.resolveExisting(
			"skill://missing/SKILL.md",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
		for (const input of [path.join(skillRoot, "SKILL.md"), path.join(alias, "SKILL.md")]) {
			expect(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }))
				.toMatchObject({ ok: false, error: { code: "access-denied" } });
		}
		expect(await namespace.paths.resolveTarget(
			path.join(outsideAlias, "removed-skill", "new.md"),
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
	});
	it.skipIf(process.platform === "win32")("rejects mounted path traversal and symbolic-link escapes", async () => {
		const skillRoot = path.join(outside, "bounded-skill");
		await mkdir(skillRoot);
		await writeFile(path.join(outside, "secret.txt"), "secret");
		await symlink(path.join(outside, "secret.txt"), path.join(skillRoot, "escape.txt"));
		const namespace = await openNamespace({
			pathAccess: {
				mounts: [{ logicalRoot: "skill://demo", nativeRoot: skillRoot }],
				protectedRoots: [skillRoot],
				managedSchemes: ["skill"],
			},
		});
		for (const input of ["skill://demo/../secret.txt", "skill://demo/a//b", "skill://demo/a\\b", "skill://demo/a%2fb"]) {
			expect(await namespace.paths.resolveExisting(input, { expected: "any", followFinalSymlink: true }))
				.toMatchObject({ ok: false, error: { code: "invalid-path" } });
		}
		expect(await namespace.paths.resolveExisting(
			"skill://demo/escape.txt",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
		expect(await namespace.paths.resolveTarget(
			"skill://demo/escape.txt",
		)).toMatchObject({ ok: false, error: { code: "access-denied" } });
	});
	it("enforces lexical blocked rules and preserves directory trailing-slash semantics", async () => {
		await mkdir(path.join(workspace, "secret"));
		await writeFile(path.join(workspace, "secret", "key.txt"), "key");
		const directoryRule = await openNamespace({ blockedPaths: ["secret/"] });
		expect(await directoryRule.paths.resolveExisting(
			"secret/key.txt",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({
			ok: false,
			error: { code: "blocked", path: "secret/key.txt", details: { matchedRule: "secret/", phase: "lexical" } },
		});

		const exactRule = await openNamespace({ blockedPaths: ["secret"] });
		expect(await exactRule.paths.resolveExisting(
			"secret/key.txt",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({ ok: true });
		expect(await exactRule.paths.resolveExisting(
			"secret",
			{ expected: "directory", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "blocked", details: { matchedRule: "secret" } } });
	});
	it("expands home-directory blocked rules when constructing the access policy", async () => {
		await mkdir(path.join(outside, "protected"));
		await writeFile(path.join(outside, "protected", "secret.txt"), "secret");
		const namespace = await openNamespace({ blockedPaths: ["~/protected/"], homeDirectory: outside });

		expect(await namespace.paths.resolveExisting(
			path.join(outside, "protected", "secret.txt"),
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { matchedRule: "~/protected/", phase: "lexical" } },
		});
	});
	it("validates expected kinds and canonical containment", async () => {
		await mkdir(path.join(workspace, "dir"));
		await writeFile(path.join(workspace, "dir", "file.txt"), "x");
		await mkdir(path.join(outside, "external-dir"));
		await writeFile(path.join(outside, "external-dir", "outside.txt"), "x");
		const namespace = await openNamespace();
		expect(await namespace.paths.resolveExisting(
			"dir",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "not-file" } });
		expect(await namespace.paths.resolveExisting(
			"missing",
			{ expected: "any", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "not-found" } });
		expect(await namespace.paths.resolveTarget("")).toMatchObject({
			ok: false,
			error: { code: "invalid-path" },
		});
		const directory = await resolveDirectory(namespace, "dir");
		const inside = await resolveFile(namespace, "dir/file.txt");
		const externalDirectory = await resolveDirectory(namespace, path.join(outside, "external-dir"));
		const external = await resolveFile(namespace, path.join(outside, "external-dir", "outside.txt"));
		expect(namespace.paths.relative(directory, directory)).toBe("");
		expect(namespace.paths.relative(directory, inside)).toBe("file.txt");
		expect(namespace.paths.relative(externalDirectory, external)).toBe("outside.txt");
		expect(namespace.paths.relative(directory, external)).toBeUndefined();
		expect(namespace.paths.isWithin(directory, inside)).toBe(true);
		expect(namespace.paths.isWithin(directory, external)).toBe(false);
		const otherNamespace = await openNamespace();
		const otherExternal = await resolveFile(otherNamespace, path.join(outside, "external-dir", "outside.txt"));
		expect(namespace.paths.relative(directory, otherExternal)).toBeUndefined();
		expect(namespace.paths.isWithin(directory, otherExternal)).toBe(false);
	});
	it("拒绝复制或伪造的引用，但保留原始引用的归属", async () => {
		await writeFile(path.join(workspace, "owned.txt"), "owned");
		const namespace = await openNamespace();
		const original = await resolveFile(namespace, "owned.txt");
		const copied = { ...original };
		expect(namespace.bridge.getNativeIdentity(original)?.canonicalPath).toBe(path.join(workspace, "owned.txt"));
		expect(namespace.bridge.getNativeIdentity(copied)).toBeUndefined();
		expect(namespace.paths.relative(namespace.root, copied)).toBeUndefined();
		expect(await namespace.bridge.revalidateExisting(copied)).toMatchObject({ ok: false, error: { code: "invalid-path" } });
	});
	it("maps native errors, rethrows unknown failures, and honors cancellation", async () => {
		await writeFile(path.join(workspace, "denied.txt"), "x");
		await writeFile(path.join(workspace, "invalid.txt"), "x");
		await writeFile(path.join(workspace, "stat-denied.txt"), "x");
		await writeFile(path.join(workspace, "unknown-error.txt"), "x");
		const base = new NodeNativeFileSystem();
		const deniedPath = path.join(workspace, "denied.txt");
		const invalidPath = path.join(workspace, "invalid.txt");
		const statDeniedPath = path.join(workspace, "stat-denied.txt");
		const unknownErrorPath = path.join(workspace, "unknown-error.txt");
		const native = overrideNativeFileSystem({
			async lstat(file, options) {
				if (file === deniedPath) throw new NativeFileSystemError("access-denied", "lstat", file);
				if (file === invalidPath) throw new NativeFileSystemError("invalid-path", "lstat", file);
				if (file === unknownErrorPath) throw new Error("injected unknown error");
				const metadata = await base.lstat(file, options);
				return file === statDeniedPath ? { ...metadata, kind: "symlink" } : metadata;
			},
			async stat(file, options) {
				if (file === statDeniedPath) throw new NativeFileSystemError("access-denied", "stat", file);
				return await base.stat(file, options);
			},
		}, base);
		const namespace = await openNamespace({ native });
		for (const [input, code] of [
			["denied.txt", "access-denied"],
			["invalid.txt", "invalid-path"],
			["stat-denied.txt", "access-denied"],
		] as const) {
			expect(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }))
				.toMatchObject({ ok: false, error: { code, path: input } });
		}
		await expect(namespace.paths.resolveExisting(
			"unknown-error.txt",
			{ expected: "file", followFinalSymlink: true },
		)).rejects.toThrow("injected unknown error");
		for (const [input, code] of [["stat-denied.txt", "access-denied"], ["invalid.txt", "invalid-path"]] as const) {
			expect(await namespace.paths.resolveTarget(input))
				.toMatchObject({ ok: false, error: { code, path: input } });
		}

		const controller = new AbortController();
		const cancelledNamespace = await openNamespace({ native, signal: controller.signal });
		controller.abort();
		expect(await cancelledNamespace.paths.resolveExisting(
			".",
			{ expected: "directory", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "aborted" } });
	});
});

async function resolveFile(namespace: WorkspaceNamespaceKernel, input: string) {
	return expectFsOk(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }));
}

async function resolveDirectory(namespace: WorkspaceNamespaceKernel, input: string) {
	return expectFsOk(await namespace.paths.resolveExisting(input, { expected: "directory", followFinalSymlink: true }));
}

async function openNamespace(options: {
	readonly blockedPaths?: readonly string[];
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
	readonly signal?: AbortSignal;
	readonly pathAccess?: FilesystemPathAccess;
} = {}): Promise<WorkspaceNamespaceKernel> {
	return expectFsOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: options.blockedPaths ?? [],
		...(options.pathAccess === undefined ? {} : { pathAccess: options.pathAccess }),
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		...(options.native === undefined ? {} : { native: options.native }),
		...(options.signal === undefined ? {} : { context: { signal: options.signal } }),
	}));
}
