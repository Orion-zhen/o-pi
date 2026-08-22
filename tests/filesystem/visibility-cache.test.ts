import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

import { createWorkspaceNamespace } from "../../src/filesystem/kernel/namespace.js";
import { GitTrackedFilesLoader } from "../../src/filesystem/services/visibility/git-tracked-files.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk } from "./fixtures.js";
import { controlledGitNative, hasGit, nextImmediate } from "./visibility-fixtures.js";

const execFileAsync = promisify(execFile);
const workspaceTemp = useTempDir("o-pi-visibility-git-");
let workspace: string;

beforeEach(() => {
	workspace = workspaceTemp.path;
});

describe("visibility Git shared state", () => {
	it("分离 consumer 取消并由 clear 终止 pending owner", async () => {
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

	it("WorkspaceVisibilityService.dispose 清理 pending Git I/O", async () => {
		if (!(await hasGit())) return;
		await execFileAsync("git", ["init"], { cwd: workspace });
		const controlled = controlledGitNative(workspace);
		const namespace = expectFsOk(await createWorkspaceNamespace({
			workspaceRoot: workspace,
			blockedPaths: [],
			native: controlled.native,
		}));
		const service = new WorkspaceVisibilityService(controlled.native);
		const pending = service.createOperations(
			path.resolve(workspace),
			createVisibilityPolicy({ ignore: { builtinProfile: "none" } }),
			namespace,
			{},
		);
		await controlled.started.promise;
		service.dispose();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		await controlled.ownerAborted.promise;
		expect(controlled.ownerAborts()).toBe(1);
		controlled.release.resolve();
	});
});
