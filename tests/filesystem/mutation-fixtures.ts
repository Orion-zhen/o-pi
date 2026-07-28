import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

import type { TargetRef } from "../../src/filesystem/contracts/path.js";
import type { FilesystemPolicy } from "../../src/filesystem/contracts/policy.js";
import { FileSystemRuntime, type WorkspaceFileSystemLease } from "../../src/filesystem/runtime.js";
import type { NativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk } from "./fixtures.js";

export function useMutationFixture(prefix: string) {
	const temp = useTempDir(prefix);
	let workspace: string;
	let runtimes: FileSystemRuntime[];

	beforeEach(async () => {
		workspace = path.join(temp.path, "workspace");
		await mkdir(workspace);
		runtimes = [];
	});
	afterEach(() => {
		for (const runtime of runtimes) runtime.dispose();
	});

	function policy(blockedPaths: readonly string[] = []): FilesystemPolicy {
		const visibility = createVisibilityPolicy();
		return { blockedPaths, visibility, fingerprint: JSON.stringify({ blockedPaths, visibility: visibility.fingerprint }) };
	}

	function track(runtime: FileSystemRuntime): FileSystemRuntime {
		runtimes.push(runtime);
		return runtime;
	}

	return {
		get root() { return temp.path; },
		get workspace() { return workspace; },
		policy,
		track,
		async openRuntime(blockedPaths: readonly string[] = [], native?: NativeFileSystem): Promise<WorkspaceFileSystemLease> {
			const runtime = track(new FileSystemRuntime(native === undefined ? {} : { native }));
			return expectFsOk(await runtime.open({ cwd: workspace, policy: policy(blockedPaths) }));
		},
		async resolveTarget(opened: WorkspaceFileSystemLease, input: string): Promise<TargetRef> {
			return expectFsOk(await opened.filesystem.paths.resolveTarget(input, { followExistingSymlink: true }, opened.context));
		},
	};
}
