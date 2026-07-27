import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	stat,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import path from "node:path";

export type NativePathKind = "file" | "directory" | "symlink" | "other";

export interface NativeMetadata {
	readonly kind: NativePathKind;
	readonly sizeBytes: number;
	readonly modifiedAtMs: number;
	/** Stable identity of one filesystem object, independent of content changes. */
	readonly identity: string;
	/** Permission bits suitable for preserving an existing file's mode. */
	readonly mode: number;
	/** Stable metadata stamp used to detect control-plane file changes. */
	readonly version: string;
}

export interface NativeDirectoryEntry {
	readonly name: string;
	readonly kind: NativePathKind;
}

export interface NativeOperationOptions {
	readonly signal?: AbortSignal;
}

export interface NativeAtomicReplaceOptions extends NativeOperationOptions {
	readonly mode?: number;
	/** Runs after the temporary file is closed and immediately before rename. */
	readonly beforeCommit?: () => Promise<void>;
}

export interface NativeOpenFile {
	/** Metadata captured from the opened handle during the no-follow identity check. */
	readonly metadata: NativeMetadata;
	read(buffer: Uint8Array, offset: number, length: number, position: number, options?: NativeOperationOptions): Promise<number>;
	close(): Promise<void>;
}

export type NativeFileSystemErrorCode =
	| "not-found"
	| "not-directory"
	| "is-directory"
	| "access-denied"
	| "already-exists"
	| "invalid-path"
	| "changed"
	| "aborted"
	| "io-error";

export class NativeFileSystemError extends Error {
	constructor(
		readonly code: NativeFileSystemErrorCode,
		readonly operation: string,
		readonly path: string,
		options?: ErrorOptions,
	) {
		super(`${operation} failed for ${path}`, options);
		this.name = "NativeFileSystemError";
	}
}

/** Narrow, injectable platform boundary used by filesystem kernel and services. */
export interface NativeFileSystem {
	lstat(path: string, options?: NativeOperationOptions): Promise<NativeMetadata>;
	stat(path: string, options?: NativeOperationOptions): Promise<NativeMetadata>;
	realpath(path: string, options?: NativeOperationOptions): Promise<string>;
	readdir(path: string, options?: NativeOperationOptions): Promise<readonly NativeDirectoryEntry[]>;
	readlink(path: string, options?: NativeOperationOptions): Promise<string>;
	read(path: string, options?: NativeOperationOptions): Promise<Uint8Array>;
	/** Opens a regular final component without following a symlink at that component. */
	open(path: string, options?: NativeOperationOptions): Promise<NativeOpenFile>;
	/** Writes through an exclusive same-directory temp and atomically replaces the destination. */
	atomicReplace(path: string, bytes: Uint8Array, options?: NativeAtomicReplaceOptions): Promise<void>;
	mkdir(path: string, options?: NativeOperationOptions & { readonly recursive?: boolean }): Promise<void>;
}

const TEMP_CREATE_ATTEMPTS = 8;
const WINDOWS_IO_ATTEMPTS = 6;
const WINDOWS_TRANSIENT_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export class NodeNativeFileSystem implements NativeFileSystem {
	async lstat(pathname: string, options: NativeOperationOptions = {}): Promise<NativeMetadata> {
		return runNative("lstat", pathname, options.signal, async () => metadataFromStats(await lstat(pathname, { bigint: true })));
	}

	async stat(pathname: string, options: NativeOperationOptions = {}): Promise<NativeMetadata> {
		return runNative("stat", pathname, options.signal, async () => metadataFromStats(await stat(pathname, { bigint: true })));
	}

	async realpath(pathname: string, options: NativeOperationOptions = {}): Promise<string> {
		return runNative("realpath", pathname, options.signal, () => realpath(pathname));
	}

	async readdir(pathname: string, options: NativeOperationOptions = {}): Promise<readonly NativeDirectoryEntry[]> {
		return runNative("readdir", pathname, options.signal, async () => {
			const entries = await readdir(pathname, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, kind: kindFromDirent(entry) }));
		});
	}

	async readlink(pathname: string, options: NativeOperationOptions = {}): Promise<string> {
		return runNative("readlink", pathname, options.signal, () => readlink(pathname));
	}

	async read(pathname: string, options: NativeOperationOptions = {}): Promise<Uint8Array> {
		return runNative("read", pathname, options.signal, () => readFile(pathname, { signal: options.signal }));
	}

	async open(pathname: string, options: NativeOperationOptions = {}): Promise<NativeOpenFile> {
		return runNative("open", pathname, options.signal, async () => {
			const before = await lstat(pathname, { bigint: true });
			const beforeMetadata = metadataFromStats(before);
			if (beforeMetadata.kind === "symlink") throw new NativeFileSystemError("changed", "open", pathname);
			let handle: FileHandle | undefined;
			try {
				// Windows has no portable O_NOFOLLOW; the lstat/fstat identity sandwich rejects swaps before any read.
				const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
				handle = await open(pathname, flags);
				const openedMetadata = metadataFromStats(await handle.stat({ bigint: true }));
				const afterMetadata = metadataFromStats(await lstat(pathname, { bigint: true }));
				if (!sameIdentity(beforeMetadata, openedMetadata) || !sameIdentity(openedMetadata, afterMetadata)) {
					throw new NativeFileSystemError("changed", "open", pathname);
				}
				// 资源所有权转移前检查取消；转移后由调用方负责关闭，避免 runNative 丢失已打开 handle。
				throwIfAborted(options.signal, "open", pathname);
				const result = new NodeNativeOpenFile(handle, pathname, openedMetadata);
				handle = undefined;
				return result;
			} finally {
				if (handle !== undefined) await closeIgnoringError(handle);
			}
		}, false);
	}

	async atomicReplace(pathname: string, bytes: Uint8Array, options: NativeAtomicReplaceOptions = {}): Promise<void> {
		await runNative("atomic-replace", pathname, options.signal, async () => {
			const temporary = await createTemporaryFile(pathname, options.mode);
			let committed = false;
			let failure: unknown;
			try {
				try {
					await temporary.handle.writeFile(bytes, { signal: options.signal });
					if (options.mode !== undefined) await temporary.handle.chmod(options.mode & 0o7777);
				} finally {
					await temporary.handle.close();
				}
				throwIfAborted(options.signal, "atomic-replace", pathname);
				await options.beforeCommit?.();
				throwIfAborted(options.signal, "atomic-replace", pathname);
				await renameWithWindowsRetry(temporary.path, pathname, options.signal);
				committed = true;
			} catch (error) {
				failure = error;
			}
			if (!committed) {
				try {
					await unlinkTemporaryWithWindowsRetry(temporary.path);
				} catch (cleanupError) {
					failure ??= cleanupError;
				}
			}
			if (failure !== undefined) throw failure;
		}, false);
	}

	async mkdir(pathname: string, options: NativeOperationOptions & { readonly recursive?: boolean } = {}): Promise<void> {
		await runNative("mkdir", pathname, options.signal, async () => {
			await mkdir(pathname, { recursive: options.recursive ?? false });
		}, false);
	}
}

class NodeNativeOpenFile implements NativeOpenFile {
	constructor(
		private readonly handle: FileHandle,
		private readonly path: string,
		readonly metadata: NativeMetadata,
	) {}

	async read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
		options: NativeOperationOptions = {},
	): Promise<number> {
		return runNative("read", this.path, options.signal, async () => {
			const result = await this.handle.read(buffer, offset, length, position);
			return result.bytesRead;
		});
	}

	async close(): Promise<void> {
		try {
			await this.handle.close();
		} catch (error) {
			throw toNativeError(error, "close", this.path);
		}
	}
}

async function createTemporaryFile(destination: string, mode: number | undefined): Promise<{ readonly path: string; readonly handle: FileHandle }> {
	const directory = path.dirname(destination);
	for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
		const temporaryPath = path.join(directory, `.pi-${randomUUID()}.tmp`);
		try {
			const handle = await open(
				temporaryPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
				mode ?? 0o666,
			);
			return { path: temporaryPath, handle };
		} catch (error) {
			if (nodeErrorCode(error) !== "EEXIST" || attempt + 1 === TEMP_CREATE_ATTEMPTS) throw error;
		}
	}
	throw new Error("Temporary file creation exhausted attempts.");
}

async function renameWithWindowsRetry(source: string, destination: string, signal: AbortSignal | undefined): Promise<void> {
	// Windows scanners can briefly hold a closed temp or destination; retry without unlinking the destination.
	const attempts = process.platform === "win32" ? WINDOWS_IO_ATTEMPTS : 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		throwIfAborted(signal, "rename", destination);
		try {
			await rename(source, destination);
			return;
		} catch (error) {
			if (attempt + 1 === attempts || !WINDOWS_TRANSIENT_CODES.has(nodeErrorCode(error) ?? "")) throw error;
			await abortableDelay(10 * 2 ** attempt, signal, destination);
		}
	}
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined, pathname: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new NativeFileSystemError("aborted", "rename", pathname, { cause: signal.reason }));
			return;
		}
		const timer = setTimeout(done, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new NativeFileSystemError("aborted", "rename", pathname, { cause: signal?.reason }));
		};
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function unlinkTemporaryWithWindowsRetry(pathname: string): Promise<void> {
	const attempts = process.platform === "win32" ? WINDOWS_IO_ATTEMPTS : 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			await unlink(pathname);
			return;
		} catch (error) {
			const code = nodeErrorCode(error);
			if (code === "ENOENT") return;
			if (attempt + 1 === attempts || !WINDOWS_TRANSIENT_CODES.has(code ?? "")) throw error;
			await abortableDelay(10 * 2 ** attempt, undefined, pathname);
		}
	}
}

async function closeIgnoringError(handle: FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch {
		// The open/identity failure is authoritative.
	}
}

async function runNative<T>(
	operation: string,
	pathname: string,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
	checkAfter = true,
): Promise<T> {
	throwIfAborted(signal, operation, pathname);
	try {
		const result = await run();
		if (checkAfter) throwIfAborted(signal, operation, pathname);
		return result;
	} catch (error) {
		if (error instanceof NativeFileSystemError) throw error;
		throw toNativeError(error, operation, pathname);
	}
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string, pathname: string): void {
	if (signal?.aborted === true) throw new NativeFileSystemError("aborted", operation, pathname, { cause: signal.reason });
}

function toNativeError(error: unknown, operation: string, pathname: string): NativeFileSystemError {
	const errno = nodeErrorCode(error);
	let code: NativeFileSystemErrorCode;
	if (isAbortError(error)) code = "aborted";
	else if (errno === "ENOENT") code = "not-found";
	else if (errno === "ENOTDIR") code = "not-directory";
	else if (errno === "EISDIR") code = "is-directory";
	else if (errno === "EACCES" || errno === "EPERM") code = "access-denied";
	else if (errno === "EEXIST") code = "already-exists";
	else if (errno === "EINVAL" || errno === "ENAMETOOLONG" || errno === "ELOOP") code = "invalid-path";
	else code = "io-error";
	return new NativeFileSystemError(code, operation, pathname, { cause: error });
}

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isAbortError(error: unknown): boolean {
	return nodeErrorCode(error) === "ABORT_ERR" || (error instanceof Error && error.name === "AbortError");
}

function metadataFromStats(info: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	dev: bigint;
	ino: bigint;
	mode: bigint;
	size: bigint;
	mtimeMs: bigint;
	ctimeMs: bigint;
}): NativeMetadata {
	const identity = `${info.dev}:${info.ino}`;
	return {
		kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
		sizeBytes: Number(info.size),
		modifiedAtMs: Number(info.mtimeMs),
		identity,
		mode: Number(info.mode & 0o7777n),
		version: `${identity}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
	};
}

function sameIdentity(left: NativeMetadata, right: NativeMetadata): boolean {
	return left.kind === right.kind && left.identity === right.identity;
}

function kindFromDirent(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): NativePathKind {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	return "other";
}
