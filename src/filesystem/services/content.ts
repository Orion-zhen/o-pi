import type {
	ByteContent,
	ReadOptions,
	ContentOperations,
	LineScan,
	ScannedLine,
	TextContent,
	TextSlice,
	TextSliceOptions,
} from "../contracts/content.js";
import type { FileSnapshot } from "../contracts/metadata.js";
import type { FileRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../contracts/result.js";
import { mapNativeError } from "../kernel/native-error.js";
import type { NativePathIdentity, WorkspaceNamespaceBridge } from "../kernel/namespace.js";
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
		private readonly context: FsOperationContext,
	) {}

	async readBytes(file: FileRef, options: ReadOptions): Promise<FsResult<ByteContent>> {
		const context = this.context;
		const identity = nativeIdentity(this.bridge, file);
		if (!identity.ok) return identity;

		const opened = await openValidatedFile(this.native, this.bridge, file, identity.value, context);
		if (!opened.ok) return opened;
		const { handle, metadata: before } = opened.value;
		if (options.expectedSnapshot !== undefined && !sameSnapshot(before, options.expectedSnapshot)) {
			await closeQuietly(handle);
			return changedDuringRead(file.displayPath, "read");
		}

		let outcome: FsResult<ByteContent>;
		try {
			if (options.maxBytes !== undefined && before.sizeBytes > options.maxBytes) {
				outcome = tooLarge(file.displayPath, options.maxBytes, before.sizeBytes);
			} else {
				const loaded = await readHandleBytes(handle, options.maxBytes, before.sizeBytes, context, file.displayPath);
				if (!loaded.ok) outcome = loaded;
				else {
					const stable = await verifyStable(
						this.bridge,
						file,
						handle.metadata,
						identity.value,
						before,
					);
					outcome = !stable.ok ? stable : stable.value
						? fsSuccess(toByteContent(loaded.value))
						: changedDuringRead(file.displayPath, "read");
				}
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

	async readText(file: FileRef, options: ReadOptions): Promise<FsResult<TextContent>> {
		const loaded = await this.readBytes(file, options);
		if (!loaded.ok) return loaded;
		return this.decodeText(loaded.value, file.displayPath);
	}

	decodeText(content: ByteContent, path: string): FsResult<TextContent> {
		const decoded = decodeUtf8(content.bytes, path);
		if (!decoded.ok) return decoded;
		return fsSuccess({ ...content, text: decoded.value, ...describeText(content.bytes, decoded.value) });
	}

	sliceText(content: TextContent, options: TextSliceOptions): FsResult<TextSlice> {
		return sliceTextByLineRange(content, options);
	}

	async scanLines(file: FileRef, options: ReadOptions): Promise<FsResult<LineScan>> {
		const context = this.context;
		const identity = nativeIdentity(this.bridge, file);
		if (!identity.ok) return identity;
		const opened = await openValidatedFile(this.native, this.bridge, file, identity.value, context);
		if (!opened.ok) return opened;
		const { handle, metadata: before } = opened.value;
		if (options.expectedSnapshot !== undefined && !sameSnapshot(before, options.expectedSnapshot)) {
			await closeQuietly(handle);
			return changedDuringRead(file.displayPath, "scan");
		}
		try {
			if (options.maxBytes !== undefined && before.sizeBytes > options.maxBytes) {
				await closeQuietly(handle);
				return tooLarge(file.displayPath, options.maxBytes, before.sizeBytes);
			}
			return fsSuccess(new NativeLineScan(
				this.bridge,
				file,
				handle,
				before,
				identity.value,
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
	private stopped = false;
	private aborted = false;
	private closePromise: Promise<void> | undefined;
	private readonly onAbort = () => {
		this.aborted = true;
		void this.closeHandle().catch(() => { /* Iterator cleanup owns close failures. */ });
	};

	constructor(
		private readonly bridge: WorkspaceNamespaceBridge,
		private readonly file: FileRef,
		private readonly handle: NativeOpenFile,
		private readonly before: NativeMetadata,
		private readonly identity: NativePathIdentity,
		private readonly options: ReadOptions,
		private readonly context: FsOperationContext,
	) {
		if (context.signal?.aborted === true) this.onAbort();
		else context.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<FsResult<ScannedLine>> {
		return this.iterate();
	}

	async close(): Promise<void> {
		this.stopped = true;
		this.context.signal?.removeEventListener("abort", this.onAbort);
		await this.closeHandle();
	}

	private closeHandle(): Promise<void> {
		this.closePromise ??= this.handle.close();
		return this.closePromise;
	}

	private isAborted(): boolean {
		return this.aborted || this.context.signal?.aborted === true;
	}

	private async *iterate(): AsyncGenerator<FsResult<ScannedLine>> {
		const displayPath = this.file.displayPath;
		let position = 0;
		const pendingSegments: Uint8Array[] = [];
		let pendingBytes = 0;
		let pendingStart = 0;
		let pendingCrOffset: number | undefined;
		let line = 1;
		let bodyBomBytes = 0;
		let yieldedAbort = false;
		const appendPending = (segment: Uint8Array): void => {
			if (segment.byteLength === 0) return;
			pendingSegments.push(segment);
			pendingBytes += segment.byteLength;
		};
		const takePending = (): Uint8Array => {
			const bytes = materializeSegments(pendingSegments, pendingBytes);
			pendingSegments.length = 0;
			pendingBytes = 0;
			return bytes;
		};
		const decodeLineBytes = (bytes: Uint8Array): FsResult<ScannedLine> => {
			if (line === 1 && hasUtf8Bom(bytes)) bodyBomBytes = UTF8_BOM_BYTES;
			return decodeScannedLine(bytes, pendingStart, line, bodyBomBytes, displayPath);
		};
		try {
			if (this.isAborted()) {
				yieldedAbort = true;
				yield fsFailure({ code: "aborted", message: "Operation aborted.", path: displayPath });
				return;
			}
			while (!this.stopped) {
				if (this.isAborted()) {
					yieldedAbort = true;
					yield fsFailure({ code: "aborted", message: "Operation aborted.", path: displayPath });
					return;
				}
				const buffer = new Uint8Array(readBufferSize(position, this.options.maxBytes, this.before.sizeBytes));
				const bytesRead = await this.handle.read(buffer, 0, buffer.byteLength, position, this.context);
				if (bytesRead === 0) break;
				const chunkStart = position;
				const chunk = buffer.subarray(0, bytesRead);
				position += bytesRead;
				if (this.options.maxBytes !== undefined && position > this.options.maxBytes) {
					yield tooLarge(displayPath, this.options.maxBytes, position);
					return;
				}

				let index = 0;
				if (pendingCrOffset !== undefined) {
					const hasLf = chunk[0] === 0x0a;
					const decoded = decodeLineBytes(takePending());
					if (!decoded.ok) {
						yield decoded;
						return;
					}
					yield decoded;
					line += 1;
					pendingStart = pendingCrOffset + (hasLf ? 2 : 1);
					pendingCrOffset = undefined;
					if (hasLf) index = 1;
				}

				let segmentStart = index;
				while (index < chunk.byteLength) {
					const byte = chunk[index];
					if (byte !== 0x0a && byte !== 0x0d) {
						index += 1;
						continue;
					}
					appendPending(chunk.subarray(segmentStart, index));
					if (byte === 0x0d && index + 1 === chunk.byteLength) {
						pendingCrOffset = chunkStart + index;
						index += 1;
						segmentStart = index;
						break;
					}

					const terminatorBytes = byte === 0x0d && chunk[index + 1] === 0x0a ? 2 : 1;
					const decoded = decodeLineBytes(takePending());
					if (!decoded.ok) {
						yield decoded;
						return;
					}
					yield decoded;
					line += 1;
					index += terminatorBytes;
					pendingStart = chunkStart + index;
					segmentStart = index;
				}
				appendPending(chunk.subarray(segmentStart));
			}

			if (!this.stopped && (pendingBytes > 0 || pendingCrOffset !== undefined)) {
				const trailingCr = pendingCrOffset !== undefined;
				const payload = takePending();
				if (!(line === 1 && !trailingCr && payload.byteLength === UTF8_BOM_BYTES && hasUtf8Bom(payload))) {
					const decoded = decodeLineBytes(payload);
					if (!decoded.ok) {
						yield decoded;
						return;
					}
					yield decoded;
				}
			}
			if (!this.stopped) {
				const stable = await verifyStable(
					this.bridge,
					this.file,
					this.handle.metadata,
					this.identity,
					this.before,
				);
				if (!stable.ok) yield stable;
				else if (!stable.value) yield changedDuringRead(displayPath, "scan");
			}
		} catch (error) {
			if (!yieldedAbort && this.isAborted()) {
				yield fsFailure({ code: "aborted", message: "Operation aborted.", path: displayPath });
			} else if (!yieldedAbort) yield fsFailure(mapNativeError(error, displayPath));
		} finally {
			try {
				await this.close();
			} catch {
				// The handle is already leaving scope; a close failure cannot be represented after early return.
			}
		}
	}
}

export async function readHandleBytes(
	handle: NativeOpenFile,
	maxBytes: number | undefined,
	sizeHint: number,
	context: FsOperationContext,
	displayPath: string,
): Promise<FsResult<Uint8Array>> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const buffer = new Uint8Array(readBufferSize(total, maxBytes, sizeHint));
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
	bodyBomBytes: number,
	displayPath: string,
): FsResult<ScannedLine> {
	const leadingBomBytes = line === 1 && hasUtf8Bom(bytes) ? bodyBomBytes : 0;
	const decoded = decodeUtf8(bytes.subarray(leadingBomBytes), displayPath);
	if (!decoded.ok) return decoded;
	return fsSuccess({
		line,
		text: decoded.value,
		byteStart: Math.max(0, rawStart - bodyBomBytes),
		byteEnd: rawStart + bytes.byteLength - bodyBomBytes,
	});
}

function toByteContent(bytes: Uint8Array): ByteContent {
	return { bytes, hash: contentHash(bytes), sizeBytes: bytes.byteLength };
}

export async function openValidatedFile(
	native: NativeFileSystem,
	bridge: WorkspaceNamespaceBridge,
	file: FileRef,
	identity: NativePathIdentity,
	context: FsOperationContext,
): Promise<FsResult<{ readonly handle: NativeOpenFile; readonly metadata: NativeMetadata }>> {
	let handle: NativeOpenFile;
	try {
		handle = await native.open(identity.nativePath, context);
	} catch (error) {
		const fresh = await bridge.revalidateExisting(file);
		if (!fresh.ok) return fresh;
		return nativeChanged(error)
			? changedDuringRead(file.displayPath, "read")
			: fsFailure(mapNativeError(error, file.displayPath));
	}
	try {
		const validated = await revalidateOpenedFile(bridge, file, identity, handle.metadata);
		if (!validated.ok) {
			await closeQuietly(handle);
			return validated;
		}
		return fsSuccess({ handle, metadata: validated.value });
	} catch (error) {
		await closeQuietly(handle);
		return fsFailure(mapNativeError(error, file.displayPath));
	}
}

async function revalidateOpenedFile(
	bridge: WorkspaceNamespaceBridge,
	file: FileRef,
	expected: NativePathIdentity,
	openedMetadata: NativeMetadata,
): Promise<FsResult<NativeMetadata>> {
	const fresh = await bridge.revalidateExisting(file);
	if (!fresh.ok) {
		return fresh.error.code === "not-found" || fresh.error.code === "not-file"
			? changedDuringRead(file.displayPath, "read")
			: fresh;
	}
	if (
		fresh.value.ref.kind !== "file"
		|| !sameNativePath(fresh.value.identity.canonicalPath, expected.canonicalPath)
		|| !sameNativePath(fresh.value.identity.nativePath, expected.nativePath)
	) return changedDuringRead(file.displayPath, "read");
	if (openedMetadata.kind !== "file") {
		return fsFailure({ code: "not-file", message: "Path is not a regular file.", path: file.displayPath });
	}
	if (fresh.value.metadata.kind !== "file" || openedMetadata.identity !== fresh.value.metadata.identity) {
		return changedDuringRead(file.displayPath, "read");
	}
	return fsSuccess(fresh.value.metadata);
}

export async function verifyStable(
	bridge: WorkspaceNamespaceBridge,
	file: FileRef,
	openedMetadata: NativeMetadata,
	identity: NativePathIdentity,
	before: NativeMetadata,
): Promise<FsResult<boolean>> {
	const after = await revalidateOpenedFile(bridge, file, identity, openedMetadata);
	if (!after.ok) return after.error.code === "changed-during-read" ? fsSuccess(false) : after;
	return fsSuccess(sameVersion(before, after.value));
}

function readBufferSize(position: number, maxBytes: number | undefined, sizeHint: number): number {
	const budget = maxBytes === undefined ? READ_CHUNK_BYTES : Math.min(READ_CHUNK_BYTES, maxBytes - position + 1);
	if (position < sizeHint) return Math.max(1, Math.min(budget, sizeHint - position));
	if (position === sizeHint) return 1;
	return Math.max(1, budget);
}

function sameVersion(left: NativeMetadata, right: NativeMetadata): boolean {
	return left.kind === right.kind && left.version === right.version;
}

function sameSnapshot(metadata: NativeMetadata, expected: FileSnapshot): boolean {
	return metadata.identity === expected.identity
		&& metadata.version === expected.version
		&& metadata.sizeBytes === expected.sizeBytes;
}

function sameNativePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

function nativeChanged(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "changed";
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

function materializeSegments(segments: readonly Uint8Array[], total: number): Uint8Array {
	const only = segments[0];
	if (segments.length === 1 && only !== undefined) return only;
	return concatChunks(segments, total);
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
