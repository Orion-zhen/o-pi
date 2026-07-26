import type {
	ByteContent,
	ByteReadOptions,
	ContentOperations,
	LineScan,
	ScannedLine,
	TextContent,
	TextReadOptions,
	TextSlice,
	TextSliceOptions,
} from "../contracts/content.js";
import type { FileRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { WorkspaceNamespaceBridge } from "../kernel/namespace.js";
import type {
	NativeFileSystem,
	NativeMetadata,
	NativeOpenFile,
} from "../platform/node/native-filesystem.js";
import { contentHash, decodeUtf8, describeText, hasUtf8Bom, sliceTextByLineRange } from "./text.js";
import { nativeIdentity } from "./ref.js";

const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_BOM_BYTES = 3;

/** Bounded, stable content access over guarded filesystem refs. */
export class WorkspaceContentService implements ContentOperations {
	constructor(
		private readonly native: NativeFileSystem,
		private readonly bridge: WorkspaceNamespaceBridge,
	) {}

	async readBytes(file: FileRef, options: ByteReadOptions, context: FsOperationContext): Promise<FsResult<ByteContent>> {
		const invalidLimit = validateMaxBytes(options.maxBytes, file.displayPath);
		if (invalidLimit !== undefined) return invalidLimit;
		const identity = nativeIdentity(this.bridge, file);
		if (!identity.ok) return identity;

		let handle: NativeOpenFile;
		try {
			handle = await this.native.open(identity.value.nativePath, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, file.displayPath));
		}

		let outcome: FsResult<ByteContent>;
		try {
			const before = await handle.stat(context);
			if (before.kind !== "file") {
				outcome = fsFailure({ code: "not-file", message: "Path is not a regular file.", path: file.displayPath });
			} else if (options.maxBytes !== undefined && before.sizeBytes > options.maxBytes) {
				outcome = tooLarge(file.displayPath, options.maxBytes, before.sizeBytes);
			} else {
				const loaded = await readHandleBytes(handle, options.maxBytes, context, file.displayPath);
				if (!loaded.ok) outcome = loaded;
				else if (options.stable === true) {
					const stable = await verifyStable(
						this.native,
						handle,
						identity.value.nativePath,
						before,
						context,
						file.displayPath,
					);
					outcome = !stable.ok ? stable : stable.value
						? fsSuccess(toByteContent(loaded.value))
						: changedDuringRead(file.displayPath, "read");
				} else outcome = fsSuccess(toByteContent(loaded.value));
			}
		} catch (error) {
			outcome = fsFailure(mapNativeError(error, file.displayPath));
		}

		try {
			await handle.close();
		} catch (error) {
			if (outcome.ok) return fsFailure(mapNativeError(error, file.displayPath));
		}
		return outcome;
	}

	async readText(file: FileRef, options: TextReadOptions, context: FsOperationContext): Promise<FsResult<TextContent>> {
		const loaded = await this.readBytes(file, options, context);
		if (!loaded.ok) return loaded;
		return this.decodeText(loaded.value, {
			...(options.rejectBinary === undefined ? {} : { rejectBinary: options.rejectBinary }),
			path: file.displayPath,
		});
	}

	decodeText(
		content: ByteContent,
		options: Pick<TextReadOptions, "rejectBinary"> & { readonly path?: string },
	): FsResult<TextContent> {
		const decoded = decodeUtf8(content.bytes, {
			rejectBinary: options.rejectBinary ?? true,
			...(options.path === undefined ? {} : { path: options.path }),
		});
		if (!decoded.ok) return decoded;
		return fsSuccess({ ...content, text: decoded.value, ...describeText(content.bytes, decoded.value) });
	}

	sliceText(content: TextContent, options: TextSliceOptions): FsResult<TextSlice> {
		return sliceTextByLineRange(content, options);
	}

	async scanLines(file: FileRef, options: TextReadOptions, context: FsOperationContext): Promise<FsResult<LineScan>> {
		const invalidLimit = validateMaxBytes(options.maxBytes, file.displayPath);
		if (invalidLimit !== undefined) return invalidLimit;
		const identity = nativeIdentity(this.bridge, file);
		if (!identity.ok) return identity;
		let handle: NativeOpenFile;
		try {
			handle = await this.native.open(identity.value.nativePath, context);
		} catch (error) {
			return fsFailure(mapNativeError(error, file.displayPath));
		}
		try {
			const before = await handle.stat(context);
			if (before.kind !== "file") {
				await closeQuietly(handle);
				return fsFailure({ code: "not-file", message: "Path is not a regular file.", path: file.displayPath });
			}
			if (options.maxBytes !== undefined && before.sizeBytes > options.maxBytes) {
				await closeQuietly(handle);
				return tooLarge(file.displayPath, options.maxBytes, before.sizeBytes);
			}
			return fsSuccess(new NativeLineScan(
				this.native,
				handle,
				before,
				identity.value.nativePath,
				file.displayPath,
				options,
				context,
			));
		} catch (error) {
			await closeQuietly(handle);
			return fsFailure(mapNativeError(error, file.displayPath));
		}
	}
}

class NativeLineScan implements LineScan {
	private consumed = false;
	private closed = false;

	constructor(
		private readonly native: NativeFileSystem,
		private readonly handle: NativeOpenFile,
		private readonly before: NativeMetadata,
		private readonly nativePath: string,
		private readonly displayPath: string,
		private readonly options: TextReadOptions,
		private readonly context: FsOperationContext,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<FsResult<ScannedLine>> {
		return this.iterate();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.handle.close();
	}

	private async *iterate(): AsyncGenerator<FsResult<ScannedLine>> {
		if (this.consumed) {
			yield fsFailure({ code: "invalid-path", message: "Line scan has already been consumed.", path: this.displayPath });
			return;
		}
		this.consumed = true;
		let position = 0;
		let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
		let pendingStart = 0;
		let line = 1;
		try {
			while (!this.closed) {
				const remaining = this.options.maxBytes === undefined
					? READ_CHUNK_BYTES
					: Math.min(READ_CHUNK_BYTES, this.options.maxBytes - position + 1);
				const buffer = new Uint8Array(Math.max(1, remaining));
				const bytesRead = await this.handle.read(buffer, 0, buffer.byteLength, position, this.context);
				if (bytesRead === 0) break;
				position += bytesRead;
				if (this.options.maxBytes !== undefined && position > this.options.maxBytes) {
					yield tooLarge(this.displayPath, this.options.maxBytes, position);
					return;
				}
				pending = concatBytes(pending, buffer.subarray(0, bytesRead));
				let recordStart = 0;
				for (let index = 0; index < pending.byteLength; index += 1) {
					const byte = pending[index];
					if (byte !== 0x0a && byte !== 0x0d) continue;
					if (byte === 0x0d && index + 1 === pending.byteLength) break;
					const terminatorBytes = byte === 0x0d && pending[index + 1] === 0x0a ? 2 : 1;
					const decoded = decodeScannedLine(
						pending.subarray(recordStart, index),
						pendingStart + recordStart,
						line,
						this.options.rejectBinary ?? true,
						this.displayPath,
					);
					if (!decoded.ok) {
						yield decoded;
						return;
					}
					yield decoded;
					line += 1;
					recordStart = index + terminatorBytes;
					index += terminatorBytes - 1;
				}
				if (recordStart > 0) {
					pending = pending.subarray(recordStart);
					pendingStart += recordStart;
				}
			}

			if (!this.closed && pending.byteLength > 0) {
				const trailingCr = pending[pending.byteLength - 1] === 0x0d;
				const payload = trailingCr ? pending.subarray(0, -1) : pending;
				if (!(line === 1 && payload.byteLength === UTF8_BOM_BYTES && hasUtf8Bom(payload))) {
					const decoded = decodeScannedLine(
						payload,
						pendingStart,
						line,
						this.options.rejectBinary ?? true,
						this.displayPath,
					);
					if (!decoded.ok) {
						yield decoded;
						return;
					}
					yield decoded;
				}
			}
			if (!this.closed && this.options.stable === true) {
				const stable = await verifyStable(
					this.native,
					this.handle,
					this.nativePath,
					this.before,
					this.context,
					this.displayPath,
				);
				if (!stable.ok) yield stable;
				else if (!stable.value) yield changedDuringRead(this.displayPath, "scan");
			}
		} catch (error) {
			yield fsFailure(mapNativeError(error, this.displayPath));
		} finally {
			try {
				await this.close();
			} catch {
				// The handle is already leaving scope; a close failure cannot be represented after early return.
			}
		}
	}
}

async function readHandleBytes(
	handle: NativeOpenFile,
	maxBytes: number | undefined,
	context: FsOperationContext,
	displayPath: string,
): Promise<FsResult<Uint8Array>> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const remaining = maxBytes === undefined ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, maxBytes - total + 1);
		const buffer = new Uint8Array(Math.max(1, remaining));
		const bytesRead = await handle.read(buffer, 0, buffer.byteLength, total, context);
		if (bytesRead === 0) break;
		total += bytesRead;
		if (maxBytes !== undefined && total > maxBytes) return tooLarge(displayPath, maxBytes, total);
		chunks.push(buffer.subarray(0, bytesRead));
	}
	return fsSuccess(concatChunks(chunks, total));
}

function decodeScannedLine(
	bytes: Uint8Array,
	rawStart: number,
	line: number,
	rejectBinary: boolean,
	displayPath: string,
): FsResult<ScannedLine> {
	const bomBytes = line === 1 && hasUtf8Bom(bytes) ? UTF8_BOM_BYTES : 0;
	const payload = bytes.subarray(bomBytes);
	const decoded = decodeUtf8(payload, { rejectBinary, path: displayPath });
	if (!decoded.ok) return decoded;
	return fsSuccess({
		line,
		text: decoded.value,
		byteStart: rawStart + bomBytes,
		byteEnd: rawStart + bytes.byteLength,
	});
}

function toByteContent(bytes: Uint8Array): ByteContent {
	return { bytes, hash: contentHash(bytes), sizeBytes: bytes.byteLength };
}

async function verifyStable(
	native: NativeFileSystem,
	handle: NativeOpenFile,
	nativePath: string,
	before: NativeMetadata,
	context: FsOperationContext,
	displayPath: string,
): Promise<FsResult<boolean>> {
	try {
		const afterHandle = await handle.stat(context);
		const afterPath = await native.stat(nativePath, context);
		return fsSuccess(sameVersion(before, afterHandle) && sameVersion(before, afterPath));
	} catch (error) {
		const mapped = mapNativeError(error, displayPath);
		return mapped.code === "aborted" ? fsFailure(mapped) : fsSuccess(false);
	}
}

function sameVersion(left: NativeMetadata, right: NativeMetadata): boolean {
	if (left.kind !== right.kind) return false;
	if (left.version !== undefined && right.version !== undefined) return left.version === right.version;
	return left.sizeBytes === right.sizeBytes && left.modifiedAtMs === right.modifiedAtMs;
}

function validateMaxBytes(maxBytes: number | undefined, displayPath: string): FsResult<never> | undefined {
	if (maxBytes === undefined || (Number.isSafeInteger(maxBytes) && maxBytes >= 0)) return undefined;
	return fsFailure({ code: "invalid-path", message: "Byte limit must be a non-negative integer.", path: displayPath });
}

function changedDuringRead(displayPath: string, operation: "read" | "scan"): FsResult<never> {
	return fsFailure({
		code: "changed-during-read",
		message: `File changed while it was being ${operation === "read" ? "read" : "scanned"}.`,
		path: displayPath,
	});
}

function tooLarge(displayPath: string, limit: number, size: number): FsResult<never> {
	return fsFailure({
		code: "too-large",
		message: "File exceeds the configured byte limit.",
		path: displayPath,
		details: { limit, size },
	});
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return right.slice();
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) return chunks[0]?.slice() ?? new Uint8Array(0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function closeQuietly(handle: NativeOpenFile): Promise<void> {
	try {
		await handle.close();
	} catch {
		// The primary operation error is authoritative.
	}
}
