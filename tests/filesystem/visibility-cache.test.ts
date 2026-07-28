import { execFile } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PartialIgnoreConfig, VisibilitySnapshot } from "../../src/filesystem/contracts/visibility.js";
import { NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { GitTrackedFilesLoader } from "../../src/filesystem/services/visibility/git-tracked-files.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { createVisibilitySnapshot, defaultVisibilityService as defaultIgnoreEngine, WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { overrideNativeFileSystem } from "./fixtures.js";
import { controlledGitNative, controlledVisibilityNative, hasGit, nextImmediate } from "./visibility-fixtures.js";

const execFileAsync = promisify(execFile);

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-visibility-cache-");
const outsideTemp = useTempDir("o-pi-visibility-cache-outside-");

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	defaultIgnoreEngine.invalidate();
});

afterEach(() => {
	defaultIgnoreEngine.invalidate();
});

async function createIgnoreSnapshot(root: string, ignore: PartialIgnoreConfig = {}): Promise<VisibilitySnapshot> {
	return await createVisibilitySnapshot(root, createVisibilityPolicy({ ignore }));
}

describe("visibility snapshot cache", () => {
	it("snapshot 不可变，新 snapshot 才看到 ignore 文件变化，并支持缓存复用", async () => {
		await writeFile(path.join(workspace, ".piignore"), "old.txt\n");
		const first = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		const cached = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		expect(cached.generation).toBe(first.generation);
		expect(cached.fingerprint).toBe(first.fingerprint);
		expect(first.diagnostics).toEqual([]);
		expect(first.evaluate({ path: "old.txt", kind: "file", intent: "search" }).ignored).toBe(true);

		await writeFile(path.join(workspace, ".piignore"), "new-longer-name.txt\n");
		const second = await createIgnoreSnapshot(workspace, { builtinProfile: "none", gitignore: { enabled: false } });
		expect(second.generation).not.toBe(first.generation);
		expect(second.fingerprint).not.toBe(first.fingerprint);
		expect(first.evaluate({ path: "new-longer-name.txt", kind: "file", intent: "search" }).ignored).toBe(false);
		expect(second.evaluate({ path: "new-longer-name.txt", kind: "file", intent: "search" }).ignored).toBe(true);
	});

	it.each(["首个", "后加入"] as const)("snapshot %s consumer 可独立取消", async (cancelledConsumer) => {
		const controlled = controlledVisibilityNative(workspace);
		const service = new WorkspaceVisibilityService(controlled.native);
		const policy = createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } });
		const controllers = [new AbortController(), new AbortController()] as const;
		const first = service.createSnapshot(
			workspace,
			policy,
			cancelledConsumer === "首个" ? { signal: controllers[0].signal } : undefined,
		);
		await controlled.started.promise;
		const second = service.createSnapshot(workspace, policy, { signal: controllers[1].signal });
		await controlled.secondRealpath.promise;
		await nextImmediate();
		const cancelledIndex = cancelledConsumer === "首个" ? 0 : 1;
		const requests = [first, second] as const;
		try {
			controllers[cancelledIndex].abort("consumer left");
			await expect(requests[cancelledIndex]).rejects.toMatchObject({ code: "aborted" });
			expect(controlled.ownerAborts()).toBe(0);
			controlled.release.resolve();
			await expect(requests[1 - cancelledIndex]).resolves.toMatchObject({ fingerprint: expect.any(String) });
			expect(controlled.rootReads()).toBe(1);
		} finally {
			controlled.release.resolve();
			service.invalidate();
		}
	});

	it("最后一个 snapshot consumer 离开或 invalidate 时终止 owner I/O", async () => {
		const policy = createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } });
		const abandoned = controlledVisibilityNative(workspace);
		const abandonedService = new WorkspaceVisibilityService(abandoned.native);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = abandonedService.createSnapshot(workspace, policy, { signal: firstController.signal });
		await abandoned.started.promise;
		const second = abandonedService.createSnapshot(workspace, policy, { signal: secondController.signal });
		await abandoned.secondRealpath.promise;
		await nextImmediate();
		firstController.abort("first left");
		secondController.abort("second left");
		await expect(first).rejects.toMatchObject({ code: "aborted" });
		await expect(second).rejects.toMatchObject({ code: "aborted" });
		await abandoned.ownerAborted.promise;
		expect(abandoned.ownerAborts()).toBe(1);

		const invalidated = controlledVisibilityNative(workspace);
		const invalidatedService = new WorkspaceVisibilityService(invalidated.native);
		const active = invalidatedService.createSnapshot(workspace, policy);
		await invalidated.started.promise;
		invalidatedService.invalidate(workspace);
		await expect(active).rejects.toMatchObject({ code: "aborted" });
		await invalidated.ownerAborted.promise;
		expect(invalidated.ownerAborts()).toBe(1);

		const globallyInvalidated = controlledVisibilityNative(workspace);
		const globalService = new WorkspaceVisibilityService(globallyInvalidated.native);
		const globallyActive = globalService.createSnapshot(workspace, policy);
		await globallyInvalidated.started.promise;
		globalService.invalidate();
		await expect(globallyActive).rejects.toMatchObject({ code: "aborted" });
		await globallyInvalidated.ownerAborted.promise;
		expect(globallyInvalidated.ownerAborts()).toBe(1);

		abandoned.release.resolve();
		invalidated.release.resolve();
		globallyInvalidated.release.resolve();
		abandonedService.invalidate();
		invalidatedService.invalidate();
	});

	it("Git shared refresh 分离 consumer 取消并由 clear 终止 pending owner", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		const shared = controlledGitNative(workspace);
		const loader = new GitTrackedFilesLoader(shared.native);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = loader.load(workspace, firstController.signal);
		const second = loader.load(workspace, secondController.signal);
		await shared.started.promise;
		await shared.secondMarker.promise;
		await nextImmediate();
		try {
			firstController.abort("first left");
			await expect(first).rejects.toMatchObject({ code: "aborted" });
			expect(shared.ownerAborts()).toBe(0);
			shared.release.resolve();
			await expect(second).resolves.toMatchObject({ paths: expect.any(Set), fingerprint: expect.any(String) });
		} finally {
			shared.release.resolve();
			loader.clear();
		}

		const cleared = controlledGitNative(workspace);
		const clearedLoader = new GitTrackedFilesLoader(cleared.native);
		const pending = clearedLoader.load(workspace);
		await cleared.started.promise;
		clearedLoader.clear();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		await cleared.ownerAborted.promise;
		expect(cleared.ownerAborts()).toBe(1);
		cleared.release.resolve();
	});

	it("canonical root、policy 与 fingerprint 共同决定 snapshot cache", async () => {
		await writeFile(path.join(workspace, ".piignore"), "ignored.txt\n");
		const alias = path.join(outside, "workspace-link");
		try {
			await symlink(workspace, alias, "dir");
		} catch {
			return;
		}
		const policy = createVisibilityPolicy({
			ignore: { builtinProfile: "none", gitignore: { enabled: false } },
			configFingerprint: "one",
		});
		const direct = await createVisibilitySnapshot(workspace, policy);
		const throughAlias = await createVisibilitySnapshot(alias, policy);
		const changedPolicy = await createVisibilitySnapshot(workspace, createVisibilityPolicy({
			ignore: { builtinProfile: "none", gitignore: { enabled: false } },
			configFingerprint: "two",
		}));

		expect(throughAlias.generation).toBe(direct.generation);
		expect(changedPolicy.generation).not.toBe(direct.generation);
	});

	it("失效中的旧构建不能回写 cache，控制面读取使用注入的 Node backend", async () => {
		await writeFile(path.join(workspace, ".piignore"), "old.txt\n");
		const base = new NodeNativeFileSystem();
		let releaseFirstRead = (): void => undefined;
		let markFirstReadStarted = (): void => undefined;
		const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve; });
		const firstReadRelease = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
		let ignoreReads = 0;
		const native = overrideNativeFileSystem({
			async read(filePath, options) {
				if (filePath !== path.join(workspace, ".piignore") || ignoreReads++ > 0) return await base.read(filePath, options);
				const captured = await base.read(filePath, options);
				markFirstReadStarted();
				await firstReadRelease;
				return captured;
			},
		}, base);
		const service = new WorkspaceVisibilityService(native);
		const policy = createVisibilityPolicy({ ignore: { builtinProfile: "none", gitignore: { enabled: false } } });
		const staleBuild = service.createSnapshot(workspace, policy);
		await firstReadStarted;
		service.invalidate(workspace);
		await writeFile(path.join(workspace, ".piignore"), "new.txt\n");
		const current = await service.createSnapshot(workspace, policy);
		releaseFirstRead();
		const stale = await staleBuild;
		const cached = await service.createSnapshot(workspace, policy);

		expect(stale.evaluate({ path: "old.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(current.evaluate({ path: "new.txt", kind: "file", intent: "search" }).ignored).toBe(true);
		expect(cached.generation).toBe(current.generation);
		expect(cached.generation).not.toBe(stale.generation);
	});
});
