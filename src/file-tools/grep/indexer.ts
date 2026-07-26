import picomatch from "picomatch";
import pLimit from "p-limit";

import { languageFromPath, splitTokens, type AnalyzedFileIndex, type ParsedFileIndex } from "../../code-index/parser.js";
import type { TextContent } from "../../filesystem/contracts/content.js";
import type { DirectoryRef, ExistingRef, FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, isFailed, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { FileToolLimits } from "../../file-tool-limits.js";
import { AbortGrepParse, GrepParser, GREP_CONCURRENCY, GREP_PARSER_BATCH_SIZE } from "./parser-pool.js";
import type { GrepMatchMode, GrepSkippedFiles } from "./types.js";

export interface GrepCandidateFile {
	readonly path: string;
	readonly id: string;
	readonly size: number;
	readonly metadataVersion: string;
	readonly contentHash: string;
	readonly index: ParsedFileIndex;
	readonly parserStatus: AnalyzedFileIndex["status"];
}

export interface GrepScopedFile {
	readonly path: string;
	readonly id: string;
	readonly size: number;
	readonly metadataVersion: string;
}

export interface GrepIndexResult {
	readonly root: ExistingRef;
	readonly files: GrepCandidateFile[];
	readonly scopedFiles: GrepScopedFile[];
	readonly matchedFiles: GrepScopedFile[];
	readonly sourceText: Map<string, string>;
	readonly sourceHashes: Map<string, string>;
	readonly skipped: GrepSkippedFiles;
	readonly scanComplete: boolean;
}

export interface GrepIndexContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly limits: Pick<FileToolLimits, "grep_max_file_bytes" | "grep_max_files_scanned" | "grep_max_semantic_files" | "grep_max_semantic_parse_bytes">;
}

interface RawGrepIndexResult extends Omit<GrepIndexResult, "root"> {}
interface WorkspaceCache { files: Map<string, CachedFileIndex> }
interface CachedFileIndex {
	path: string;
	id: string;
	size: number;
	metadataVersion: string;
	hash?: string;
	index?: ParsedFileIndex;
	parserStatus?: AnalyzedFileIndex["status"];
	misses: Set<string>;
}
type ParsedCachedFile = CachedFileIndex & { hash: string; index: ParsedFileIndex; parserStatus: AnalyzedFileIndex["status"] };
interface PendingGrepIndex {
	promise: Promise<ToolOutcome<RawGrepIndexResult>>;
	controller: AbortController;
	consumers: number;
	settled: boolean;
	abortTimer?: ReturnType<typeof setImmediate>;
}
interface ContentFilter {
	readonly key: string;
	matchesLine(line: string): boolean;
}
interface WalkState {
	readonly context: GrepIndexContext;
	readonly root: ExistingRef;
	readonly cache: WorkspaceCache;
	readonly signal: AbortSignal;
	readonly matchesGlob?: (candidate: string) => boolean;
	readonly contentFilter?: ContentFilter;
	readonly semanticFilter: (text: string, path: string) => number | undefined;
	readonly semanticFilterKey: string;
	files: GrepCandidateFile[];
	scopedFiles: GrepScopedFile[];
	matchedFiles: GrepScopedFile[];
	sourceText: Map<string, string>;
	sourceHashes: Map<string, string>;
	skipped: Required<GrepSkippedFiles>;
	pendingFiles: PendingFile[];
	seenIds: Set<string>;
	scanComplete: boolean;
	semanticPrefilter: boolean;
	offloadParsing: boolean;
}
interface PendingFile { ref: FileRef; searchPath: string; explicit: boolean }
interface PreparedFile {
	ref: FileRef;
	metadata: GrepScopedFile;
	loaded: TextContent;
	semanticRank?: number;
	cachedAnalysis?: ParsedCachedFile;
}

/** Grep-owned derived index and shared-build lifecycle. */
export class GrepIndex {
	private readonly parser = new GrepParser();
	private readonly workspaceCaches = new Map<string, WorkspaceCache>();
	private readonly pendingIndexes = new Map<string, PendingGrepIndex>();
	private disposed = false;

	async get(
		root: ExistingRef,
		params: { readonly query: string; readonly match: GrepMatchMode; readonly glob?: string },
		context: GrepIndexContext,
	): Promise<ToolOutcome<GrepIndexResult>> {
		if (this.disposed || context.operation.signal?.aborted === true) return aborted(root.displayPath);
		const glob = params.glob === undefined ? undefined : validateGlob(params.glob, root.displayPath);
		if (isFailed(glob)) return glob;
		const contentFilter = createContentFilter(params.query, params.match);
		if (isFailed(contentFilter)) return contentFilter;
		const matchesGlob = glob === undefined ? undefined : picomatch(glob, { dot: true, nonegate: true });
		const cacheKey = `${context.filesystem.identity}\0${context.filesystem.visibility.snapshot.fingerprint}`;
		const cache = this.workspaceCaches.get(cacheKey) ?? { files: new Map<string, CachedFileIndex>() };
		this.workspaceCaches.set(cacheKey, cache);
		const filterKey = contentFilter?.key ?? `auto\0${params.query.toLocaleLowerCase()}`;
		const key = [cacheKey, root.displayPath, root.kind, glob ?? "", filterKey, limitsKey(context.limits)].join("\0");
		let pending = this.pendingIndexes.get(key);
		if (pending === undefined) {
			const controller = new AbortController();
			const state: WalkState = {
				context,
				root,
				cache,
				signal: controller.signal,
				...(matchesGlob === undefined ? {} : { matchesGlob }),
				...(contentFilter === undefined ? {} : { contentFilter }),
				semanticFilter: createSemanticFilter(params.query),
				semanticFilterKey: `auto\0${params.query.toLocaleLowerCase()}`,
				files: [],
				scopedFiles: [],
				matchedFiles: [],
				sourceText: new Map(),
				sourceHashes: new Map(),
				skipped: { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0 },
				pendingFiles: [],
				seenIds: new Set(),
				scanComplete: true,
				semanticPrefilter: false,
				offloadParsing: false,
			};
			pending = { promise: this.build(state), controller, consumers: 0, settled: false };
			this.pendingIndexes.set(key, pending);
			void this.settle(key, pending);
		}
		const result = await consumePending(pending, context.operation.signal, root.displayPath);
		return isFailed(result) ? result : { root, ...cloneRawResult(result) };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.workspaceCaches.clear();
		for (const pending of this.pendingIndexes.values()) {
			if (pending.abortTimer !== undefined) clearImmediate(pending.abortTimer);
			pending.controller.abort();
		}
		this.pendingIndexes.clear();
		this.parser.dispose();
	}

	private async build(state: WalkState): Promise<ToolOutcome<RawGrepIndexResult>> {
		try {
			assertNotAborted(state.signal);
			if (state.root.kind === "file") {
				const result = await this.queueExplicitFile(state, state.root);
				if (isFailed(result)) return result;
			} else if (state.root.kind === "directory") {
				const walked = await this.discoverDirectory(state, state.root);
				if (isFailed(walked)) return walked;
			} else return fail("INVALID_PATH", "Path must be a regular file or directory.", { path: state.root.displayPath });
			state.semanticPrefilter = state.contentFilter === undefined
				&& state.pendingFiles.length > state.context.limits.grep_max_semantic_files;
			await this.indexPendingFiles(state);
		} catch (error) {
			if (error instanceof ExplicitFileFailure) return error.result;
			if (error instanceof AbortGrepIndex || error instanceof AbortGrepParse) return aborted(state.root.displayPath);
			return fail("PATH_NOT_FOUND", "Path does not exist.", { path: state.root.displayPath });
		}
		state.files.sort((left, right) => compareStableString(left.path, right.path));
		state.scopedFiles.sort((left, right) => compareStableString(left.path, right.path));
		state.matchedFiles.sort((left, right) => compareStableString(left.path, right.path));
		return {
			files: state.files,
			scopedFiles: state.scopedFiles,
			matchedFiles: state.matchedFiles,
			sourceText: state.sourceText,
			sourceHashes: state.sourceHashes,
			skipped: compactSkipped(state.skipped),
			scanComplete: state.scanComplete,
		};
	}

	private async settle(key: string, pending: PendingGrepIndex): Promise<void> {
		try { await pending.promise; } catch { /* Consumers receive the rejection. */ }
		finally {
			if (pending.abortTimer !== undefined) clearImmediate(pending.abortTimer);
			pending.settled = true;
			if (this.pendingIndexes.get(key) === pending) this.pendingIndexes.delete(key);
		}
	}

	private async queueExplicitFile(state: WalkState, ref: FileRef): Promise<ToolOutcome<void>> {
		const metadata = await scopedMetadata(ref, state);
		if (isFailed(metadata)) return metadata;
		if (metadata.size > state.context.limits.grep_max_file_bytes) {
			return fail("OUTPUT_LIMIT_EXCEEDED", "File is too large to search.", { path: ref.displayPath });
		}
		addScopedFile(state, metadata);
		const searchPath = basename(ref.displayPath);
		if (state.matchesGlob !== undefined && !state.matchesGlob(searchPath)) return;
		state.matchedFiles.push(metadata);
		state.pendingFiles.push({ ref, searchPath, explicit: true });
	}

	private async discoverDirectory(state: WalkState, root: DirectoryRef): Promise<ToolOutcome<void>> {
		const opened = await state.context.filesystem.traversal.walk(root, {
			intent: "index",
			explicitRoot: true,
		}, { signal: state.signal });
		if (!opened.ok) return mapFsError(opened.error, { message: "Path cannot be searched." });
		try {
			for await (const event of opened.value) {
				assertNotAborted(state.signal);
				if (event.type === "error") {
					if (event.error.code === "aborted") throw new AbortGrepIndex();
					if (event.error.code === "access-denied") state.skipped.access_denied += 1;
					continue;
				}
				if (event.type !== "entry" || event.ref.kind !== "file") continue;
				const metadata = await scopedMetadata(event.ref, state);
				if (isFailed(metadata)) {
					if (metadata.error.code === "OPERATION_ABORTED") throw new AbortGrepIndex();
					if (metadata.error.code === "ACCESS_DENIED") state.skipped.access_denied += 1;
					continue;
				}
				addScopedFile(state, metadata);
				const searchPath = relativeDisplayPath(root.displayPath, event.ref.displayPath);
				if (state.matchesGlob !== undefined && !state.matchesGlob(searchPath)) continue;
				if (state.pendingFiles.length >= state.context.limits.grep_max_files_scanned) {
					state.scanComplete = false;
					break;
				}
				state.matchedFiles.push(metadata);
				state.pendingFiles.push({ ref: event.ref, searchPath, explicit: false });
			}
		} finally { await opened.value.close(); }
	}

	private async indexPendingFiles(state: WalkState): Promise<void> {
		const prepareLimit = pLimit(GREP_CONCURRENCY);
		const prepared = (await Promise.all(state.pendingFiles.map(async (pending) => await prepareLimit(async () =>
			await prepareFile(state, pending))))).filter((file): file is PreparedFile => file !== undefined);
		const selected = state.semanticPrefilter
			? trimSemanticCandidates(prepared, state.context.limits.grep_max_semantic_files)
			: prepared;
		if (state.semanticPrefilter && selected.length < prepared.length) state.scanComplete = false;
		await this.parsePreparedFiles(state, selected);
	}

	private async parsePreparedFiles(state: WalkState, prepared: PreparedFile[]): Promise<void> {
		let syntaxFileCount = 0;
		let syntaxBytes = 0;
		let maxSyntaxFileBytes = 0;
		for (const file of prepared) {
			if (file.cachedAnalysis !== undefined || !shouldParseSyntax(state, file)) continue;
			syntaxFileCount += 1;
			syntaxBytes += file.loaded.sizeBytes;
			maxSyntaxFileBytes = Math.max(maxSyntaxFileBytes, file.loaded.sizeBytes);
		}
		state.offloadParsing = this.parser.shouldOffload({ fileCount: syntaxFileCount, totalBytes: syntaxBytes, maxFileBytes: maxSyntaxFileBytes });
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < prepared.length) {
				const start = cursor;
				cursor += GREP_PARSER_BATCH_SIZE;
				await this.analyzePreparedFiles(state, prepared.slice(start, start + GREP_PARSER_BATCH_SIZE));
			}
		};
		const batches = Math.ceil(prepared.length / GREP_PARSER_BATCH_SIZE);
		const concurrency = state.offloadParsing ? Math.min(GREP_CONCURRENCY, batches) : Math.min(1, batches);
		await Promise.all(Array.from({ length: concurrency }, worker));
	}

	private async analyzePreparedFiles(state: WalkState, prepared: PreparedFile[]): Promise<void> {
		if (prepared.length === 0) return;
		const pending = prepared.filter((file) => file.cachedAnalysis === undefined);
		const analyzed = await this.parser.analyzeFiles(pending.map((file) => ({
			path: file.ref.displayPath,
			text: file.loaded.text,
			syntax: shouldParseSyntax(state, file),
		})), state.signal, state.offloadParsing);
		let analyzedIndex = 0;
		for (const file of prepared) {
			if (file.cachedAnalysis !== undefined) {
				addCandidate(state, file.cachedAnalysis, file.loaded.text);
				continue;
			}
			const result = analyzed[analyzedIndex];
			analyzedIndex += 1;
			if (result !== undefined) storeAnalyzedFile(state, file, result);
		}
	}
}

async function prepareFile(state: WalkState, pending: PendingFile): Promise<PreparedFile | undefined> {
	assertNotAborted(state.signal);
	const metadata = state.matchedFiles.find((file) => file.id === pending.ref.id);
	if (metadata === undefined) return undefined;
	if (metadata.size > state.context.limits.grep_max_file_bytes) {
		if (pending.explicit) throw new Error("explicit size was not rejected");
		state.skipped.too_large += 1;
		return undefined;
	}
	const cached = state.cache.files.get(cacheFileKey(pending.ref.displayPath));
	const cacheCurrent = cached !== undefined && cached.metadataVersion === metadata.metadataVersion;
	const parsedCached = cacheCurrent && isParsedCachedFile(cached) ? cached : undefined;
	const filterKey = state.contentFilter?.key ?? (state.semanticPrefilter ? state.semanticFilterKey : undefined);
	if (filterKey !== undefined && cacheCurrent && cached.misses.has(filterKey)) return undefined;
	if (state.contentFilter !== undefined) {
		const matched = await fileMatchesFilter(pending.ref, state.contentFilter, state);
		if (isFailed(matched)) {
			if (pending.explicit) throw new ExplicitFileFailure(matched);
			countReadFailure(state, matched);
			return undefined;
		}
		if (!matched) {
			rememberFilterMiss(state, cached, metadata, state.contentFilter.key);
			return undefined;
		}
	}
	if (parsedCached !== undefined && parsedCached.parserStatus === "parsed" && state.contentFilter === undefined && !state.semanticPrefilter) {
		state.files.push(toCandidate(parsedCached));
		return undefined;
	}
	const loadedResult = await state.context.filesystem.content.readText(
		pending.ref,
		{ maxBytes: state.context.limits.grep_max_file_bytes, stable: true, rejectBinary: true },
		{ signal: state.signal },
	);
	if (!loadedResult.ok) {
		const failure = mapFsError(loadedResult.error, { notFound: "file", path: pending.ref.displayPath });
		if (pending.explicit) throw new ExplicitFileFailure(failure);
		countReadFailure(state, failure);
		return undefined;
	}
	const loaded = loadedResult.value;
	let semanticRank: number | undefined;
	if (state.semanticPrefilter) {
		semanticRank = state.semanticFilter(loaded.text, pending.ref.displayPath);
		if (semanticRank === undefined) {
			rememberFilterMiss(state, cached, metadata, state.semanticFilterKey);
			return undefined;
		}
	}
	return {
		ref: pending.ref,
		metadata,
		loaded,
		...(semanticRank === undefined ? {} : { semanticRank }),
		...(parsedCached !== undefined && parsedCached.hash === loaded.hash ? { cachedAnalysis: parsedCached } : {}),
	};
}

async function fileMatchesFilter(ref: FileRef, filter: ContentFilter, state: WalkState): Promise<ToolOutcome<boolean>> {
	const opened = await state.context.filesystem.content.scanLines(
		ref,
		{ maxBytes: state.context.limits.grep_max_file_bytes, stable: true, rejectBinary: true },
		{ signal: state.signal },
	);
	if (!opened.ok) return mapFsError(opened.error, { notFound: "file", path: ref.displayPath });
	try {
		for await (const line of opened.value) {
			if (!line.ok) return mapFsError(line.error, { notFound: "file", path: ref.displayPath });
			if (filter.matchesLine(line.value.text)) return true;
		}
		return false;
	} finally { await opened.value.close(); }
}

async function scopedMetadata(ref: FileRef, state: WalkState): Promise<ToolOutcome<GrepScopedFile>> {
	const result = await state.context.filesystem.metadata.stat(ref, { signal: state.signal });
	if (!result.ok) return mapFsError(result.error, { notFound: "file", path: ref.displayPath });
	return {
		path: ref.displayPath,
		id: ref.id,
		size: result.value.sizeBytes,
		metadataVersion: result.value.version ?? `${result.value.sizeBytes}:${result.value.modifiedAtMs}`,
	};
}

function addScopedFile(state: WalkState, metadata: GrepScopedFile): void {
	if (state.seenIds.has(metadata.id)) return;
	state.seenIds.add(metadata.id);
	if (state.scopedFiles.length < state.context.limits.grep_max_files_scanned) state.scopedFiles.push(metadata);
}

function addCandidate(state: WalkState, cached: ParsedCachedFile, text: string): void {
	state.files.push(toCandidate(cached));
	state.sourceText.set(cached.path, text);
	state.sourceHashes.set(cached.path, cached.hash);
}

function storeAnalyzedFile(state: WalkState, file: PreparedFile, analyzed: AnalyzedFileIndex): void {
	const cached: ParsedCachedFile = {
		path: file.ref.displayPath,
		id: file.ref.id,
		size: file.loaded.sizeBytes,
		metadataVersion: file.metadata.metadataVersion,
		hash: file.loaded.hash,
		index: analyzed.index,
		parserStatus: analyzed.status,
		misses: new Set(),
	};
	state.cache.files.set(cacheFileKey(file.ref.displayPath), cached);
	addCandidate(state, cached, file.loaded.text);
}

function rememberFilterMiss(state: WalkState, cached: CachedFileIndex | undefined, metadata: GrepScopedFile, key: string): void {
	const misses = new Set(cached?.metadataVersion === metadata.metadataVersion ? cached.misses : []);
	misses.add(key);
	state.cache.files.set(cacheFileKey(metadata.path), {
		...(cached?.metadataVersion === metadata.metadataVersion ? cached : {
			path: metadata.path, id: metadata.id, size: metadata.size, metadataVersion: metadata.metadataVersion,
		}),
		misses,
	});
}

function toCandidate(cached: ParsedCachedFile): GrepCandidateFile {
	return {
		path: cached.path,
		id: cached.id,
		size: cached.size,
		metadataVersion: cached.metadataVersion,
		contentHash: cached.hash,
		index: cached.index,
		parserStatus: cached.parserStatus,
	};
}

function shouldParseSyntax(state: WalkState, file: PreparedFile): boolean {
	return languageFromPath(file.ref.displayPath) !== "text"
		&& (!state.semanticPrefilter || state.contentFilter !== undefined || file.loaded.sizeBytes <= state.context.limits.grep_max_semantic_parse_bytes);
}

function trimSemanticCandidates(files: PreparedFile[], limit: number): PreparedFile[] {
	return [...files]
		.sort((left, right) => (right.semanticRank ?? 0) - (left.semanticRank ?? 0) || compareStableString(left.ref.displayPath, right.ref.displayPath))
		.slice(0, limit);
}

function createContentFilter(query: string, match: GrepMatchMode): ToolOutcome<ContentFilter | undefined> {
	if (match === "auto") return undefined;
	if (match === "literal") return { key: `literal\0${query}`, matchesLine: (line) => !query.includes("\n") && line.includes(query) };
	try {
		const expression = new RegExp(query, "gu");
		return { key: `regex\0${query}`, matchesLine(line) { const matched = expression.test(line); expression.lastIndex = 0; return matched; } };
	} catch (error) {
		return fail("INVALID_REGEX", "query is not a valid regular expression.", { details: { error: error instanceof Error ? error.message : String(error) } });
	}
}

function createSemanticFilter(query: string): (text: string, filePath: string) => number | undefined {
	const queryLower = query.toLocaleLowerCase();
	const tokens = [...new Set(splitTokens(query).map((token) => token.toLocaleLowerCase()))];
	const identifierLike = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(query);
	const requiredTokens = identifierLike || tokens.length <= 1 ? 1 : Math.min(2, tokens.length);
	const declaration = identifierLike ? new RegExp(`\\b(?:class|function|interface|type|enum|def|fn)\\s+${escapeRegex(queryLower)}\\b`, "u") : undefined;
	return function semantic(text, filePath) {
		const pathLower = filePath.toLocaleLowerCase();
		const textLower = text.toLocaleLowerCase();
		let matchedTokens = 0;
		let pathTokens = 0;
		for (const token of tokens) {
			if (textLower.includes(token)) matchedTokens += 1;
			if (pathLower.includes(token)) pathTokens += 1;
		}
		const exact = textLower.includes(queryLower) ? 1 : 0;
		if (exact === 0 && pathTokens === 0 && matchedTokens < requiredTokens) return undefined;
		return (exact && declaration?.test(textLower) === true ? 1_000_000 : 0) + exact * 100_000 + matchedTokens * 10_000 + pathTokens * 1_000 - Math.min(text.length, 999);
	};
}

function validateGlob(value: string, rootPath: string): ToolOutcome<string> {
	const glob = value.replace(/\\/gu, "/").replace(/^\.\/+/, "").replace(/\/+/gu, "/");
	if (glob.length === 0) return fail("INVALID_PATH", "glob must not be empty.", { path: rootPath });
	if (glob.includes("\0")) return fail("INVALID_PATH", "glob must not contain NUL bytes.", { path: rootPath });
	if (glob.startsWith("/") || /^[A-Za-z]:\//u.test(glob) || glob.startsWith("//")) return fail("INVALID_PATH", "glob must be relative.", { path: rootPath });
	if (glob.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "glob must not escape path.", { path: rootPath });
	return glob;
}

function relativeDisplayPath(root: string, child: string): string {
	if (root === ".") return child.replace(/^\.\//u, "").replaceAll("\\", "/");
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
	const normalizedChild = child.replaceAll("\\", "/");
	return normalizedChild.startsWith(`${normalizedRoot}/`) ? normalizedChild.slice(normalizedRoot.length + 1) : basename(normalizedChild);
}

function basename(value: string): string {
	return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function compactSkipped(skipped: Required<GrepSkippedFiles>): GrepSkippedFiles {
	return {
		...(skipped.binary > 0 ? { binary: skipped.binary } : {}),
		...(skipped.invalid_utf8 > 0 ? { invalid_utf8: skipped.invalid_utf8 } : {}),
		...(skipped.access_denied > 0 ? { access_denied: skipped.access_denied } : {}),
		...(skipped.too_large > 0 ? { too_large: skipped.too_large } : {}),
	};
}

function countReadFailure(state: WalkState, failure: ReturnType<typeof fail>): void {
	if (failure.error.code === "BINARY_FILE_UNSUPPORTED") state.skipped.binary += 1;
	else if (failure.error.code === "ENCODING_UNSUPPORTED") state.skipped.invalid_utf8 += 1;
	else if (failure.error.code === "OUTPUT_LIMIT_EXCEEDED") state.skipped.too_large += 1;
	else if (failure.error.code === "ACCESS_DENIED") state.skipped.access_denied += 1;
	else if (failure.error.code === "OPERATION_ABORTED") throw new AbortGrepIndex();
}

async function consumePending(pending: PendingGrepIndex, signal: AbortSignal | undefined, path: string): Promise<ToolOutcome<RawGrepIndexResult>> {
	if (pending.abortTimer !== undefined) { clearImmediate(pending.abortTimer); delete pending.abortTimer; }
	pending.consumers += 1;
	let onAbort: (() => void) | undefined;
	try {
		if (signal === undefined) return await pending.promise;
		if (signal.aborted) return aborted(path);
		const abortedResult = new Promise<ToolOutcome<RawGrepIndexResult>>((resolve) => {
			onAbort = () => resolve(aborted(path));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([pending.promise, abortedResult]);
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		pending.consumers -= 1;
		if (pending.consumers === 0 && !pending.settled) pending.abortTimer = setImmediate(() => {
			delete pending.abortTimer;
			if (pending.consumers === 0 && !pending.settled) pending.controller.abort();
		});
	}
}

function cloneRawResult(result: RawGrepIndexResult): RawGrepIndexResult {
	return {
		files: [...result.files], scopedFiles: [...result.scopedFiles], matchedFiles: [...result.matchedFiles],
		sourceText: new Map(result.sourceText), sourceHashes: new Map(result.sourceHashes),
		skipped: { ...result.skipped }, scanComplete: result.scanComplete,
	};
}

function isParsedCachedFile(cached: CachedFileIndex): cached is ParsedCachedFile {
	return cached.hash !== undefined && cached.index !== undefined && cached.parserStatus !== undefined;
}
function cacheFileKey(displayPath: string): string { return displayPath; }
function limitsKey(limits: GrepIndexContext["limits"]): string { return JSON.stringify(limits); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function compareStableString(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function assertNotAborted(signal: AbortSignal): void { if (signal.aborted) throw new AbortGrepIndex(); }
function aborted(path?: string) { return fail("OPERATION_ABORTED", "grep was aborted.", { ...(path === undefined ? {} : { path }) }); }
class AbortGrepIndex extends Error {}
class ExplicitFileFailure extends Error { constructor(readonly result: ReturnType<typeof fail>) { super(result.error.message); } }
