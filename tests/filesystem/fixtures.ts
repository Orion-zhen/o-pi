import { expect } from "vitest";

import type { ByteContent, LineScan, ReadOptions, TextContent } from "../../src/filesystem/contracts/content.js";
import type { DirectoryRef, ExistingRef, FileRef } from "../../src/filesystem/contracts/path.js";
import type { FsResult } from "../../src/filesystem/contracts/result.js";
import type { VisibilityPolicy } from "../../src/filesystem/contracts/visibility.js";
import { createWorkspaceNamespace, type WorkspaceNamespaceKernel } from "../../src/filesystem/kernel/namespace.js";
import {
	NodeNativeFileSystem,
	type NativeFileSystem,
} from "../../src/filesystem/platform/node/native-filesystem.js";
import {
	createReadonlyFileSystemServices,
	type ReadonlyFileSystemServices,
} from "../../src/filesystem/services/readonly.js";
import { createVisibilityPolicy } from "../../src/filesystem/services/visibility/policy.js";
import { WorkspaceVisibilityService } from "../../src/filesystem/services/visibility/service.js";

export interface OpenedReadonly {
	readonly namespace: WorkspaceNamespaceKernel;
	readonly services: ReadonlyFileSystemServices;
	resolveExisting(input: string): Promise<ExistingRef>;
	resolveFile(input: string): Promise<FileRef>;
	resolveDirectory(input: string): Promise<DirectoryRef>;
	readBytes(input: string, options?: ReadOptions): Promise<FsResult<ByteContent>>;
	readText(input: string, options?: ReadOptions): Promise<FsResult<TextContent>>;
	scanLines(input: string, options?: ReadOptions): Promise<FsResult<LineScan>>;
}

export async function openReadonly(
	workspace: string,
	options: {
		readonly native?: NativeFileSystem;
		readonly blockedPaths?: readonly string[];
		readonly policy?: VisibilityPolicy;
		readonly ownerSignal?: AbortSignal;
	} = {},
): Promise<OpenedReadonly> {
	const native = options.native ?? new NodeNativeFileSystem();
	const context = options.ownerSignal === undefined ? {} : { signal: options.ownerSignal };
	const namespace = expectFsOk(await createWorkspaceNamespace({
		workspaceRoot: workspace,
		blockedPaths: options.blockedPaths ?? [],
		native,
		context,
	}));
	const visibility = await new WorkspaceVisibilityService(native).createOperations(
		workspace,
		options.policy ?? createVisibilityPolicy({ ignore: { builtinProfile: "none" } }),
		namespace,
		context,
	);
	const services = createReadonlyFileSystemServices({ native, namespace, visibility, context });
	return {
		namespace,
		services,
		resolveExisting: async (input) => expectFsOk(await namespace.paths.resolveExisting(input, { expected: "any", followFinalSymlink: true })),
		resolveFile: (input) => resolveFile(namespace, input),
		resolveDirectory: (input) => resolveDirectory(namespace, input),
		async readBytes(input, readOptions = {}) {
			return await services.content.readBytes(await resolveFile(namespace, input), readOptions);
		},
		async readText(input, readOptions = {}) {
			return await services.content.readText(await resolveFile(namespace, input), readOptions);
		},
		async scanLines(input, readOptions = {}) {
			return await services.content.scanLines(await resolveFile(namespace, input), readOptions);
		},
	};
}

export async function resolveFile(namespace: WorkspaceNamespaceKernel, input: string): Promise<FileRef> {
	const ref = expectFsOk(await namespace.paths.resolveExisting(input, { expected: "file", followFinalSymlink: true }));
	return ref;
}

export async function resolveDirectory(namespace: WorkspaceNamespaceKernel, input: string): Promise<DirectoryRef> {
	const ref = expectFsOk(await namespace.paths.resolveExisting(input, { expected: "directory", followFinalSymlink: true }));
	return ref;
}

export function expectFsOk<T>(result: FsResult<T>): T {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

export function overrideNativeFileSystem(
	overrides: Partial<NativeFileSystem>,
	base: NativeFileSystem = new NodeNativeFileSystem(),
): NativeFileSystem {
	return {
		lstat: overrides.lstat ?? ((pathname, options) => base.lstat(pathname, options)),
		stat: overrides.stat ?? ((pathname, options) => base.stat(pathname, options)),
		realpath: overrides.realpath ?? ((pathname, options) => base.realpath(pathname, options)),
		readdir: overrides.readdir ?? ((pathname, options) => base.readdir(pathname, options)),
		readlink: overrides.readlink ?? ((pathname, options) => base.readlink(pathname, options)),
		read: overrides.read ?? ((pathname, options) => base.read(pathname, options)),
		open: overrides.open ?? ((pathname, options) => base.open(pathname, options)),
		atomicReplace: overrides.atomicReplace ?? ((pathname, bytes, options) => base.atomicReplace(pathname, bytes, options)),
		mkdir: overrides.mkdir ?? ((pathname, options) => base.mkdir(pathname, options)),
	};
}

export async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

export interface DeferredVoid {
	readonly promise: Promise<void>;
	resolve(): void;
}

export function deferredVoid(): DeferredVoid {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((complete) => { resolve = complete; });
	return { promise, resolve };
}

export function textBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}
