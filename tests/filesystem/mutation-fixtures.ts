import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";

import type {
	MutationOptions,
	MutationRunResult,
	MutationSnapshot,
	MutationTransform,
} from "../../src/filesystem/contracts/mutation.js";
import type { TargetRef } from "../../src/filesystem/contracts/path.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import type { FilesystemPolicy } from "../../src/filesystem/contracts/policy.js";
import { FileSystemRuntime, type WorkspaceFileSystemLease } from "../../src/filesystem/runtime.js";
import type { NativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { expectFsOk } from "./fixtures.js";

export function commitBytes(
	opened: WorkspaceFileSystemLease,
	target: TargetRef,
	bytes: Uint8Array,
	options: MutationOptions,
): Promise<FsResult<MutationRunResult<never>>> {
	return opened.filesystem.mutations.run(target, options, () => ({ type: "commit", bytes }));
}

type OpenMutationOptions = Readonly<{
	blockedPaths?: readonly string[];
	native?: NativeFileSystem;
	signal?: AbortSignal;
	initial?: string;
}>;

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

	async function openRuntime(
		blockedPaths: readonly string[] = [],
		native?: NativeFileSystem,
		signal?: AbortSignal,
	): Promise<WorkspaceFileSystemLease> {
		const runtime = track(new FileSystemRuntime(native === undefined ? {} : { native }));
		return expectFsOk(await runtime.open({
			cwd: workspace,
			policy: policy(blockedPaths),
			...(signal === undefined ? {} : { context: { signal } }),
		}));
	}

	async function resolveTarget(opened: WorkspaceFileSystemLease, input: string): Promise<TargetRef> {
		return expectFsOk(await opened.filesystem.paths.resolveTarget(input));
	}

	async function openMutation(input: string, options: OpenMutationOptions = {}) {
		if (options.initial !== undefined) await writeFile(path.join(workspace, input), options.initial);
		const opened = await openRuntime(options.blockedPaths, options.native, options.signal);
		const target = await resolveTarget(opened, input);
		return {
			opened,
			run<TRejected>(
				mutationOptions: MutationOptions,
				transform: (snapshot: MutationSnapshot) => MutationTransform<TRejected> | Promise<MutationTransform<TRejected>>,
			) { return opened.filesystem.mutations.run(target, mutationOptions, transform); },
			commit: (bytes: Uint8Array, mutationOptions: MutationOptions) => commitBytes(opened, target, bytes, mutationOptions),
		};
	}

	return {
		get root() { return temp.path; },
		get workspace() { return workspace; },
		policy,
		track,
		openRuntime,
		resolveTarget,
		openMutation,
		async commitPath(opened: WorkspaceFileSystemLease, input: string, bytes: Uint8Array, options: MutationOptions) {
			const target = expectFsOk(await opened.filesystem.paths.resolveTarget(input));
			return await commitBytes(opened, target, bytes, options);
		},
	};
}
