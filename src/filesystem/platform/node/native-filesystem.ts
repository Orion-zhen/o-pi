import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	stat,
	writeFile,
	type FileHandle,
} from "node:fs/promises";

export type NativePathKind = "file" | "directory" | "symlink" | "other";

export interface NativeMetadata {
	readonly kind: NativePathKind;
	readonly sizeBytes: number;
	readonly modifiedAtMs: number;
}

export interface NativeDirectoryEntry {
	readonly name: string;
	readonly kind: NativePathKind;
}

export interface NativeOperationOptions {
	readonly signal?: AbortSignal;
}

export interface NativeOpenFile {
	read(buffer: Uint8Array, offset: number, length: number, position: number, options?: NativeOperationOptions): Promise<number>;
	stat(options?: NativeOperationOptions): Promise<NativeMetadata>;
	close(): Promise<void>;
}

export type NativeFileSystemErrorCode =
	| "not-found"
	| "not-directory"
	| "is-directory"
	| "access-denied"
	| "already-exists"
	| "invalid-path"
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
	open(path: string, options?: NativeOperationOptions): Promise<NativeOpenFile>;
	write(path: string, bytes: Uint8Array, options?: NativeOperationOptions): Promise<void>;
	mkdir(path: string, options?: NativeOperationOptions & { readonly recursive?: boolean }): Promise<void>;
}

export class NodeNativeFileSystem implements NativeFileSystem {
	async lstat(path: string, options: NativeOperationOptions = {}): Promise<NativeMetadata> {
		return runNative("lstat", path, options.signal, async () => metadataFromStats(await lstat(path)));
	}

	async stat(path: string, options: NativeOperationOptions = {}): Promise<NativeMetadata> {
		return runNative("stat", path, options.signal, async () => metadataFromStats(await stat(path)));
	}

	async realpath(path: string, options: NativeOperationOptions = {}): Promise<string> {
		return runNative("realpath", path, options.signal, () => realpath(path));
	}

	async readdir(path: string, options: NativeOperationOptions = {}): Promise<readonly NativeDirectoryEntry[]> {
		return runNative("readdir", path, options.signal, async () => {
			const entries = await readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, kind: kindFromDirent(entry) }));
		});
	}

	async readlink(path: string, options: NativeOperationOptions = {}): Promise<string> {
		return runNative("readlink", path, options.signal, () => readlink(path));
	}

	async read(path: string, options: NativeOperationOptions = {}): Promise<Uint8Array> {
		return runNative("read", path, options.signal, () => readFile(path, { signal: options.signal }));
	}

	async open(path: string, options: NativeOperationOptions = {}): Promise<NativeOpenFile> {
		return runNative("open", path, options.signal, async () => new NodeNativeOpenFile(await open(path, "r"), path));
	}

	async write(path: string, bytes: Uint8Array, options: NativeOperationOptions = {}): Promise<void> {
		await runNative("write", path, options.signal, () => writeFile(path, bytes, { signal: options.signal }), false);
	}

	async mkdir(path: string, options: NativeOperationOptions & { readonly recursive?: boolean } = {}): Promise<void> {
		await runNative("mkdir", path, options.signal, async () => {
			await mkdir(path, { recursive: options.recursive ?? false });
		}, false);
	}
}

class NodeNativeOpenFile implements NativeOpenFile {
	constructor(private readonly handle: FileHandle, private readonly path: string) {}

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

	async stat(options: NativeOperationOptions = {}): Promise<NativeMetadata> {
		return runNative("fstat", this.path, options.signal, async () => metadataFromStats(await this.handle.stat()));
	}

	async close(): Promise<void> {
		try {
			await this.handle.close();
		} catch (error) {
			throw toNativeError(error, "close", this.path);
		}
	}
}

async function runNative<T>(
	operation: string,
	path: string,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
	checkAfter = true,
): Promise<T> {
	throwIfAborted(signal, operation, path);
	try {
		const result = await run();
		if (checkAfter) throwIfAborted(signal, operation, path);
		return result;
	} catch (error) {
		if (error instanceof NativeFileSystemError) throw error;
		throw toNativeError(error, operation, path);
	}
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string, path: string): void {
	if (signal?.aborted === true) throw new NativeFileSystemError("aborted", operation, path, { cause: signal.reason });
}

function toNativeError(error: unknown, operation: string, path: string): NativeFileSystemError {
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
	return new NativeFileSystemError(code, operation, path, { cause: error });
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
	size: number;
	mtimeMs: number;
}): NativeMetadata {
	return {
		kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
		sizeBytes: info.size,
		modifiedAtMs: info.mtimeMs,
	};
}

function kindFromDirent(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): NativePathKind {
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	return "other";
}
