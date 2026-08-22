import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import { NativeFileSystemError, NodeNativeFileSystem, type NativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk, overrideNativeFileSystem } from "./fixtures.js";

const temp = useTempDir("o-pi-namespace-platform-");
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

describe("workspace namespace platform boundaries", () => {
	it.skipIf(process.platform === "win32")("keeps lexical workspace display when realpath uses a different spelling", async () => {
		const realWorkspace = path.join(root, "real-workspace");
		const lexicalWorkspace = path.join(root, "lexical-workspace");
		await mkdir(realWorkspace);
		await writeFile(path.join(realWorkspace, "a.txt"), "a");
		await symlink(realWorkspace, lexicalWorkspace, "dir");
		const opened = expectFsOk(await createWorkspaceNamespace({ workspaceRoot: lexicalWorkspace, blockedPaths: [] }));
		const file = expectFsOk(await opened.paths.resolveExisting(
			path.join(lexicalWorkspace, "a.txt"),
			{ expected: "file", followFinalSymlink: true },
		));
		expect(opened.root.displayPath).toBe(".");
		expect(file).toMatchObject({ displayPath: "a.txt", workspacePath: "a.txt" });
		expect(opened.bridge.getNativeIdentity(file)?.canonicalPath).toBe(path.join(realWorkspace, "a.txt"));
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

		expect(await namespace.paths.resolveTarget("target-link.txt", { followExistingSymlink: true })).toMatchObject({
			ok: false,
			error: { code: "blocked", details: { phase: "canonical" } },
		});
		expect(await namespace.paths.resolveTarget("parent-link/new/file.txt", { followExistingSymlink: true })).toMatchObject({
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
		const danglingRef = expectFsOk(await namespace.paths.resolveExisting(
			"allowed-link.txt",
			{ expected: "any", followFinalSymlink: false },
		));
		expect(danglingRef.kind).toBe("symlink");
		const preserved = expectFsOk(await namespace.paths.resolveTarget("allowed-link.txt", { followExistingSymlink: false }));
		expect(preserved.existingKind).toBe("symlink");
		const allowed = expectFsOk(await namespace.paths.resolveTarget("allowed-link.txt", { followExistingSymlink: true }));
		expect(allowed.existingKind).toBeUndefined();
		expect(namespace.bridge.getNativeIdentity(allowed)?.nativePath).toBe(allowedTarget);
		expect(await namespace.paths.resolveTarget("blocked-link.txt", { followExistingSymlink: true })).toMatchObject({
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

		const preserved = expectFsOk(await namespace.paths.resolveExisting(
			"link.txt",
			{ expected: "any", followFinalSymlink: false },
		));
		expect(preserved.kind).toBe("symlink");
		expect(namespace.bridge.getNativeIdentity(preserved)?.nativePath).toBe(link);
		const followed = expectFsOk(await namespace.paths.resolveExisting(
			"link.txt",
			{ expected: "file", followFinalSymlink: true },
		));
		expect(followed.kind).toBe("file");
		expect(namespace.bridge.getNativeIdentity(followed)?.nativePath).toBe(target);

		const preservedTarget = expectFsOk(await namespace.paths.resolveTarget("link.txt", { followExistingSymlink: false }));
		expect(preservedTarget.existingKind).toBe("symlink");
		expect(namespace.bridge.getNativeIdentity(preservedTarget)?.nativePath).toBe(link);
		const followedTarget = expectFsOk(await namespace.paths.resolveTarget("link.txt", { followExistingSymlink: true }));
		expect(followedTarget.existingKind).toBe("file");
		expect(namespace.bridge.getNativeIdentity(followedTarget)?.nativePath).toBe(target);
	});
	it.runIf(process.platform === "win32")("computes ref-relative paths with Windows case and normalized separators", async () => {
		await mkdir(path.join(workspace, "CaseDir", "Nested"), { recursive: true });
		await writeFile(path.join(workspace, "CaseDir", "Nested", "File.txt"), "x");
		const namespace = await openNamespace();
		const directory = expectFsOk(await namespace.paths.resolveExisting(
			"casedir",
			{ expected: "directory", followFinalSymlink: true },
		));
		const file = expectFsOk(await namespace.paths.resolveExisting(
			"CASEDIR\\NESTED\\FILE.TXT",
			{ expected: "file", followFinalSymlink: true },
		));
		const relative = namespace.paths.relative(directory, file);
		expect(relative?.toLowerCase()).toBe("nested/file.txt");
		expect(relative).not.toContain("\\");
	});
	it.skipIf(process.platform === "win32")("hydrates a dangling-link destination that appears during resolution", async () => {
		const destination = path.join(outside, "appeared.txt");
		const link = path.join(workspace, "appeared-link.txt");
		await writeFile(destination, "appeared");
		await symlink(destination, link);
		const base = new NodeNativeFileSystem();
		let injectedMissing = false;
		const native = overrideNativeFileSystem({
			async realpath(file, options) {
				if (file === link && !injectedMissing) {
					injectedMissing = true;
					throw new NativeFileSystemError("not-found", "realpath", file);
				}
				return await base.realpath(file, options);
			},
		}, base);
		const namespace = await openNamespace({ native });
		const target = expectFsOk(await namespace.paths.resolveTarget("appeared-link.txt", { followExistingSymlink: true }));
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
		const native = overrideNativeFileSystem({
			async lstat(file, options) {
				const metadata = await base.lstat(file, options);
				if (file === racedPath && !replaced) {
					replaced = true;
					await rm(racedPath);
					await symlink(protectedFile, racedPath);
				}
				return metadata;
			},
		}, base);
		const namespace = await openNamespace({ blockedPaths: [`${protectedDir}${path.sep}`], native });
		expect(await namespace.paths.resolveExisting(
			"raced.txt",
			{ expected: "file", followFinalSymlink: true },
		)).toMatchObject({ ok: false, error: { code: "blocked", details: { phase: "canonical" } } });
	});
});

async function openNamespace(options: {
	readonly blockedPaths?: readonly string[];
	readonly homeDirectory?: string;
	readonly native?: NativeFileSystem;
} = {}): Promise<WorkspaceNamespaceKernel> {
	return expectFsOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: options.blockedPaths ?? [],
		...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
		...(options.native === undefined ? {} : { native: options.native }),
	}));
}
