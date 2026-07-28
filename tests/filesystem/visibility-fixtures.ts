import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
	NativeFileSystemError,
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import {
	deferredVoid,
	overrideNativeFileSystem,
	type DeferredVoid,
} from "./fixtures.js";

const execFileAsync = promisify(execFile);

interface ControlledNative {
	readonly native: NativeFileSystem;
	readonly started: DeferredVoid;
	readonly release: DeferredVoid;
	readonly ownerAborted: DeferredVoid;
	ownerAborts(): number;
}

export function controlledVisibilityNative(root: string): ControlledNative & {
	readonly secondRealpath: DeferredVoid;
	rootReads(): number;
} {
	const base = new NodeNativeFileSystem();
	const started = deferredVoid();
	const release = deferredVoid();
	const ownerAborted = deferredVoid();
	const secondRealpath = deferredVoid();
	const canonicalRoot = path.resolve(root);
	let realpaths = 0;
	let rootReads = 0;
	let ownerAborts = 0;
	return {
		started,
		release,
		ownerAborted,
		secondRealpath,
		ownerAborts: () => ownerAborts,
		rootReads: () => rootReads,
		native: overrideNativeFileSystem({
			async realpath(filePath, options) {
				const resolved = await base.realpath(filePath, options);
				if (path.resolve(filePath) === canonicalRoot) {
					realpaths += 1;
					if (realpaths >= 2) secondRealpath.resolve();
				}
				return resolved;
			},
			async readdir(directory, options) {
				if (path.resolve(directory) !== canonicalRoot) return await base.readdir(directory, options);
				rootReads += 1;
				started.resolve();
				await waitForReleaseOrAbort(options?.signal, release.promise, directory, () => {
					ownerAborts += 1;
					ownerAborted.resolve();
				});
				return await base.readdir(directory, options);
			},
		}, base),
	};
}

export function controlledGitNative(root: string): ControlledNative & { readonly secondMarker: DeferredVoid } {
	const base = new NodeNativeFileSystem();
	const started = deferredVoid();
	const release = deferredVoid();
	const ownerAborted = deferredVoid();
	const secondMarker = deferredVoid();
	const gitMarker = path.join(path.resolve(root), ".git");
	const gitConfig = path.join(gitMarker, "config");
	let markerReads = 0;
	let ownerAborts = 0;
	return {
		started,
		release,
		ownerAborted,
		secondMarker,
		ownerAborts: () => ownerAborts,
		native: overrideNativeFileSystem({
			async lstat(filePath, options) {
				const resolvedPath = path.resolve(filePath);
				if (resolvedPath === gitMarker) {
					const metadata = await base.lstat(filePath, options);
					markerReads += 1;
					if (markerReads >= 2) secondMarker.resolve();
					return metadata;
				}
				if (resolvedPath !== gitConfig) return await base.lstat(filePath, options);
				started.resolve();
				await waitForReleaseOrAbort(options?.signal, release.promise, filePath, () => {
					ownerAborts += 1;
					ownerAborted.resolve();
				});
				return await base.lstat(filePath, options);
			},
		}, base),
	};
}

export async function nextImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export function hasGit(): Promise<boolean> {
	return gitSucceeds(["--version"]);
}

async function gitSucceeds(args: readonly string[]): Promise<boolean> {
	try {
		await execFileAsync("git", args);
		return true;
	} catch {
		return false;
	}
}

async function waitForReleaseOrAbort(
	signal: AbortSignal | undefined,
	release: Promise<void>,
	filePath: string,
	onAbort: () => void,
): Promise<void> {
	let abortListener: (() => void) | undefined;
	let observed = false;
	const canceled = new Promise<void>((_resolve, reject) => {
		abortListener = () => {
			if (observed) return;
			observed = true;
			onAbort();
			reject(new NativeFileSystemError("aborted", "test", filePath));
		};
		if (signal?.aborted === true) abortListener();
		else signal?.addEventListener("abort", abortListener, { once: true });
	});
	try {
		await Promise.race([release, canceled]);
	} finally {
		if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
	}
}
