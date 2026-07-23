import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import pLimit from "p-limit";

import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "../config.js";
import { fail, isAccessDenied, isFailed, protectedPathFailure } from "../core/errors.js";
import { defaultIgnoreEngine } from "../ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../ignore/ignore-types.js";
import { languageFromPath, splitTokens, type AnalyzedFileIndex, type ParsedFileIndex } from "../../code-index/parser.js";
import { guardExistingPath, PathGuardBlockedError } from "../../safety/path-guard.js";
import { normalizeToolPath } from "../core/path-resolver.js";
import { decodeUtf8Text } from "../core/text-file.js";
import type { GrepParams, GrepSkippedFiles, ToolOutcome } from "../types.js";
import { AbortGrepParse, analyzeGrepFile, analyzeGrepFiles, clearGrepParserPool, GREP_CONCURRENCY, GREP_PARSER_BATCH_SIZE, shouldOffloadGrepParsing } from "./parser-pool.js";

export interface GrepCandidateFile {
	path: string;
	absolutePath: string;
	realPath: string;
	size: number;
	mtimeMs: number;
	contentHash: string;
	index: ParsedFileIndex;
	parserStatus: AnalyzedFileIndex["status"];
}

export interface GrepSearchRoot {
	relativePath: string;
	absolutePath: string;
	realPath: string;
	workspacePath?: string;
	kind: "file" | "directory";
}

export interface GrepIndexResult {
	workspaceRoot: string;
	root: GrepSearchRoot;
	config: FileToolsConfig;
	files: GrepCandidateFile[];
	scopedFiles: Array<{ path: string; absolutePath: string }>;
	sourceText: Map<string, string>;
	skipped: GrepSkippedFiles;
	scanComplete: boolean;
}

interface WorkspaceCache {
	files: Map<string, CachedFileIndex>;
}

interface PendingGrepIndex {
	promise: Promise<ToolOutcome<GrepIndexResult>>;
	controller: AbortController;
	consumers: number;
	settled: boolean;
	abortTimer?: ReturnType<typeof setImmediate>;
}

interface CachedFileIndex {
	path: string;
	absolutePath: string;
	realPath: string;
	size: number;
	mtimeMs: number;
	hash?: string;
	index?: ParsedFileIndex;
	parserStatus?: AnalyzedFileIndex["status"];
	misses: Set<string>;
}

type ParsedCachedFile = CachedFileIndex & {
	hash: string;
	index: ParsedFileIndex;
	parserStatus: AnalyzedFileIndex["status"];
};

interface ContentFilter {
	key: string;
	evaluate(text: string, filePath: string): number | undefined;
}

interface WalkState {
	workspaceRoot: string;
	root: GrepSearchRoot;
	config: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	matchesGlob?: (candidate: string) => boolean;
	signal?: AbortSignal;
	files: GrepCandidateFile[];
	scopedFiles: Array<{ path: string; absolutePath: string }>;
	scopedFilePaths: Set<string>;
	sourceText: Map<string, string>;
	skipped: Required<GrepSkippedFiles>;
	scannedFiles: number;
	scanComplete: boolean;
	seenPaths: Set<string>;
	cache: WorkspaceCache;
	contentFilter?: ContentFilter;
	semanticFilter: ContentFilter;
	semanticPrefilter: boolean;
	pendingFiles: PendingFile[];
	offloadParsing: boolean;
}

interface PendingFile {
	absolutePath: string;
	displayPath: string;
	explicit: boolean;
	searchPath: string;
}

interface PreparedFile {
	absolutePath: string;
	displayPath: string;
	loaded: { text: string; size: number; mtimeMs: number };
	semanticRank?: number;
	cachedAnalysis?: ParsedCachedFile;
}

const workspaceCaches = new Map<string, WorkspaceCache>();
const pendingIndexes = new Map<string, PendingGrepIndex>();

/** 构建或复用 workspace 进程内索引；缓存只保存元数据和 token，不保存完整源码。 */
export async function getGrepIndex(
	cwd: string,
	params: Omit<Pick<GrepParams, "query" | "path" | "glob" | "match">, "path"> & { path?: string },
	signal?: AbortSignal,
): Promise<ToolOutcome<GrepIndexResult>> {
	if (signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: params.path ?? "." });
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = path.resolve(cwd);
	const root = await resolveGrepRoot(workspaceRoot, params.path ?? ".", config);
	if (isFailed(root)) return root;
	const glob = params.glob === undefined ? undefined : validateGlob(params.glob, root.relativePath);
	if (isFailed(glob)) return glob;
	const contentFilter = createContentFilter(params.query, params.match);
	if (isFailed(contentFilter)) return contentFilter;
	const semanticFilter = createSemanticFilter(params.query);
	const matchesGlob = glob === undefined ? undefined : picomatch(glob, { dot: true, nonegate: true });
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	const cache = cacheFor(workspaceRoot);
	const key = [root.realPath, root.kind, glob ?? "", contentFilter?.key ?? semanticFilter.key, ignoreSnapshot.fingerprint, JSON.stringify(config)].join("\0");
	let pending = pendingIndexes.get(key);
	if (pending === undefined) {
		const controller = new AbortController();
		const state: WalkState = {
			workspaceRoot,
			root,
			config,
			ignoreSnapshot,
			...(matchesGlob !== undefined ? { matchesGlob } : {}),
			signal: controller.signal,
			files: [],
			scopedFiles: [],
			scopedFilePaths: new Set(),
			sourceText: new Map(),
			skipped: { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0 },
			scannedFiles: 0,
			scanComplete: true,
			seenPaths: new Set(),
			cache,
			pendingFiles: [],
			offloadParsing: false,
			semanticPrefilter: false,
			semanticFilter,
			...(contentFilter !== undefined ? { contentFilter } : {}),
		};
		pending = { promise: buildGrepIndex(state), controller, consumers: 0, settled: false };
		pendingIndexes.set(key, pending);
		void settlePendingIndex(key, pending);
	}
	return await consumePendingIndex(pending, signal, root.relativePath);
}

async function buildGrepIndex(state: WalkState): Promise<ToolOutcome<GrepIndexResult>> {
	const { workspaceRoot, root, config } = state;
	try {
		assertNotAborted(state.signal);
		if (root.kind === "file") {
			const indexed = await indexFile(state, root.realPath, root.relativePath, true, root.relativePath);
			if (isFailed(indexed)) return indexed;
		} else {
			await walkDirectory(state, root.realPath, root.relativePath, root.workspacePath, ".", isRootIgnored(state));
			state.semanticPrefilter = state.contentFilter === undefined
				&& state.pendingFiles.length > state.config.limits.grep_max_semantic_files;
			await indexPendingFiles(state);
		}
	} catch (error) {
		if (error instanceof AbortGrepIndex || error instanceof AbortGrepParse) return fail("OPERATION_ABORTED", "grep was aborted.", { path: root.relativePath });
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be searched.", { path: root.relativePath });
		return fail("PATH_NOT_FOUND", "Path does not exist.", { path: root.relativePath });
	}

	pruneScopedCache(state);
	state.files.sort((left, right) => compareStableString(left.path, right.path));
	return {
		workspaceRoot,
		root,
		config,
		files: state.files,
		scopedFiles: state.scopedFiles,
		sourceText: state.sourceText,
		skipped: compactSkipped(state.skipped),
		scanComplete: state.scanComplete,
	};
}

async function settlePendingIndex(key: string, pending: PendingGrepIndex): Promise<void> {
	try {
		await pending.promise;
	} catch {
		// Consumers receive the original rejection; this observer only owns cleanup.
	} finally {
		if (pending.abortTimer !== undefined) clearImmediate(pending.abortTimer);
		pending.settled = true;
		if (pendingIndexes.get(key) === pending) pendingIndexes.delete(key);
	}
}

async function consumePendingIndex(
	pending: PendingGrepIndex,
	signal: AbortSignal | undefined,
	rootPath: string,
): Promise<ToolOutcome<GrepIndexResult>> {
	if (pending.abortTimer !== undefined) {
		clearImmediate(pending.abortTimer);
		delete pending.abortTimer;
	}
	pending.consumers += 1;
	let onAbort: (() => void) | undefined;
	try {
		if (signal === undefined) return await pending.promise;
		if (signal.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: rootPath });
		const aborted = new Promise<ToolOutcome<GrepIndexResult>>((resolve) => {
			onAbort = () => resolve(fail("OPERATION_ABORTED", "grep was aborted.", { path: rootPath }));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([pending.promise, aborted]);
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		pending.consumers -= 1;
		if (pending.consumers === 0 && !pending.settled) {
			pending.abortTimer = setImmediate(() => {
				delete pending.abortTimer;
				if (pending.consumers === 0 && !pending.settled) pending.controller.abort();
			});
		}
	}
}

export function clearGrepIndex(): void {
	workspaceCaches.clear();
	for (const pending of pendingIndexes.values()) {
		if (pending.abortTimer !== undefined) clearImmediate(pending.abortTimer);
		pending.controller.abort();
	}
	pendingIndexes.clear();
	clearGrepParserPool();
}

async function resolveGrepRoot(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<GrepSearchRoot>> {
	const lexical = normalizeToolPath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;

	let real: string;
	try {
		const guarded = await guardExistingPath(inputPath, { cwd: workspaceRoot, blocked_path: config.blocked_path });
		real = guarded.real_path ?? lexical.absolutePath;
	} catch (error) {
		if (error instanceof PathGuardBlockedError) return protectedPathFailure(lexical.relativePath, error.block);
		throw error;
	}
	try {
		const info = await stat(real);
		if (info.isFile()) {
			return {
				relativePath: lexical.relativePath,
				absolutePath: lexical.absolutePath,
				realPath: real,
				...(lexical.workspacePath !== undefined ? { workspacePath: lexical.workspacePath } : {}),
				kind: "file",
			};
		}
		if (info.isDirectory()) {
			return {
				relativePath: lexical.relativePath,
				absolutePath: lexical.absolutePath,
				realPath: real,
				...(lexical.workspacePath !== undefined ? { workspacePath: lexical.workspacePath } : {}),
				kind: "directory",
			};
		}
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be accessed.", { path: lexical.relativePath });
		return fail("PATH_NOT_FOUND", "Path does not exist.", { path: lexical.relativePath });
	}
	return fail("INVALID_PATH", "Path must be a regular file or directory.", { path: lexical.relativePath });
}

async function walkDirectory(
	state: WalkState,
	absoluteDirectory: string,
	displayDirectory: string,
	workspaceDirectory: string | undefined,
	searchRelativeDirectory: string,
	ignoreBypass: boolean,
): Promise<void> {
	assertNotAborted(state.signal);
	if (!state.scanComplete) return;
	if (isBlockedPath(state.config, toolPathIdentity(displayDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (!ignoreBypass && isIgnoredPath(state.config, toolPathIdentity(displayDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (!ignoreBypass && workspaceDirectory !== undefined && workspaceDirectory !== ".") {
		const decision = state.ignoreSnapshot.evaluate({ path: workspaceDirectory, kind: "directory", intent: "index" });
		if (decision.ignored && decision.prune) return;
	}

	let entries;
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (displayDirectory === state.root.relativePath) throw error;
		if (isAccessDenied(error)) state.skipped.access_denied += 1;
		return;
	}

	for (const entry of entries.sort((left, right) => compareStableString(left.name, right.name))) {
		assertNotAborted(state.signal);
		if (!state.scanComplete) return;
		const childDisplayPath = joinDisplayPath(displayDirectory, entry.name);
		const childWorkspacePath = joinWorkspacePath(workspaceDirectory, entry.name);
		const childAbsolutePath = path.join(absoluteDirectory, entry.name);
		const childSearchPath = searchRelativeDirectory === "." ? entry.name : `${searchRelativeDirectory}/${entry.name}`;
		const identity = toolPathIdentity(childDisplayPath, childAbsolutePath, childWorkspacePath);
		if (isBlockedPath(state.config, identity)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			const decision = ignoreBypass || childWorkspacePath === undefined
				? { ignored: false, prune: false }
				: state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "directory", intent: "index" });
			if (!ignoreBypass && (isIgnoredPath(state.config, identity) || (decision.ignored && decision.prune))) continue;
			await walkDirectory(state, childAbsolutePath, childDisplayPath, childWorkspacePath, childSearchPath, ignoreBypass);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!ignoreBypass) {
			if (isIgnoredPath(state.config, identity)) continue;
			const decision = childWorkspacePath === undefined ? { ignored: false } : state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "file", intent: "index" });
			if (decision.ignored) continue;
		}
		addScopedFile(state, childDisplayPath, childAbsolutePath);
		if (state.matchesGlob !== undefined && !state.matchesGlob(childSearchPath)) continue;
		queueFile(state, childAbsolutePath, childDisplayPath, false, childSearchPath);
	}
}

function queueFile(state: WalkState, absolutePath: string, displayPath: string, explicit: boolean, searchPath: string): void {
	if (state.scannedFiles >= state.config.limits.grep_max_files_scanned) {
		state.scanComplete = false;
		return;
	}
	state.scannedFiles += 1;
	state.seenPaths.add(displayPath);
	state.pendingFiles.push({ absolutePath, displayPath, explicit, searchPath });
}

async function indexPendingFiles(state: WalkState): Promise<void> {
	if (state.semanticPrefilter) {
		await indexSemanticPendingFiles(state);
		return;
	}
	const prepareLimit = pLimit(GREP_CONCURRENCY);
	const preparedFiles: PreparedFile[] = [];
	let batchStart = 0;
	const worker = async (): Promise<void> => {
		while (batchStart < state.pendingFiles.length) {
			assertNotAborted(state.signal);
			const start = batchStart;
			batchStart += GREP_PARSER_BATCH_SIZE;
			const batch = state.pendingFiles.slice(start, start + GREP_PARSER_BATCH_SIZE);
			const prepared = (await Promise.all(batch.map((pending) => prepareLimit(async () => {
				const result = await prepareFile(state, pending.absolutePath, pending.displayPath, pending.explicit, pending.searchPath);
				return isFailed(result) ? undefined : result;
			})))).filter((file): file is PreparedFile => file !== undefined);
			preparedFiles.push(...prepared);
		}
	};
	const concurrency = Math.min(GREP_CONCURRENCY, Math.ceil(state.pendingFiles.length / GREP_PARSER_BATCH_SIZE));
	await Promise.all(Array.from({ length: concurrency }, worker));
	await parsePreparedFiles(state, preparedFiles);
}

async function indexSemanticPendingFiles(state: WalkState): Promise<void> {
	const prepareLimit = pLimit(GREP_CONCURRENCY);
	let batchStart = 0;
	let semanticCandidates = 0;
	const selected: PreparedFile[] = [];
	const semanticLimit = state.config.limits.grep_max_semantic_files;
	const worker = async (): Promise<void> => {
		while (batchStart < state.pendingFiles.length) {
			assertNotAborted(state.signal);
			const start = batchStart;
			batchStart += GREP_PARSER_BATCH_SIZE;
			const batch = state.pendingFiles.slice(start, start + GREP_PARSER_BATCH_SIZE);
			const prepared = (await Promise.all(batch.map((pending) => prepareLimit(async () => {
				const result = await prepareFile(state, pending.absolutePath, pending.displayPath, pending.explicit, pending.searchPath);
				return isFailed(result) ? undefined : result;
			})))).filter((file): file is PreparedFile => file !== undefined);
			semanticCandidates += prepared.length;
			selected.push(...prepared);
			if (selected.length > semanticLimit * 2) trimSemanticCandidates(selected, semanticLimit);
		}
	};
	const readConcurrency = Math.min(GREP_CONCURRENCY, Math.ceil(state.pendingFiles.length / GREP_PARSER_BATCH_SIZE));
	await Promise.all(Array.from({ length: readConcurrency }, worker));
	trimSemanticCandidates(selected, semanticLimit);
	if (semanticCandidates > selected.length) state.scanComplete = false;
	await parsePreparedFiles(state, selected);
}

function trimSemanticCandidates(files: PreparedFile[], limit: number): void {
	files.sort((left, right) => (right.semanticRank ?? 0) - (left.semanticRank ?? 0) || compareStableString(left.displayPath, right.displayPath));
	if (files.length > limit) files.length = limit;
}

async function parsePreparedFiles(state: WalkState, prepared: PreparedFile[]): Promise<void> {
	let syntaxFileCount = 0;
	let syntaxBytes = 0;
	let maxSyntaxFileBytes = 0;
	for (const file of prepared) {
		if (file.cachedAnalysis !== undefined) continue;
		if (!shouldParseSyntax(state, file)) continue;
		syntaxFileCount += 1;
		syntaxBytes += file.loaded.size;
		maxSyntaxFileBytes = Math.max(maxSyntaxFileBytes, file.loaded.size);
	}
	state.offloadParsing = shouldOffloadGrepParsing({
		fileCount: syntaxFileCount,
		totalBytes: syntaxBytes,
		maxFileBytes: maxSyntaxFileBytes,
	});
	let cursor = 0;
	const parseWorker = async (): Promise<void> => {
		while (cursor < prepared.length) {
			const start = cursor;
			cursor += GREP_PARSER_BATCH_SIZE;
			await analyzePreparedFiles(state, prepared.slice(start, start + GREP_PARSER_BATCH_SIZE));
		}
	};
	const batchCount = Math.ceil(prepared.length / GREP_PARSER_BATCH_SIZE);
	const concurrency = state.offloadParsing ? Math.min(GREP_CONCURRENCY, batchCount) : Math.min(1, batchCount);
	await Promise.all(Array.from({ length: concurrency }, parseWorker));
}

function shouldParseSyntax(state: WalkState, file: PreparedFile): boolean {
	return languageFromPath(file.displayPath) !== "text"
		&& (!state.semanticPrefilter
			|| state.contentFilter !== undefined
			|| file.loaded.size <= state.config.limits.grep_max_semantic_parse_bytes);
}

async function analyzePreparedFiles(state: WalkState, prepared: PreparedFile[]): Promise<void> {
	if (prepared.length === 0) return;
	const pendingAnalysis = prepared.filter((file) => file.cachedAnalysis === undefined);
	const analyzed = await analyzeGrepFiles(
		pendingAnalysis.map((file) => ({
			path: file.displayPath,
			text: file.loaded.text,
			syntax: shouldParseSyntax(state, file),
		})),
		state.signal,
		state.offloadParsing,
	);
	let analyzedIndex = 0;
	for (const file of prepared) {
		if (file.cachedAnalysis !== undefined) {
			state.files.push(toCandidate(file.cachedAnalysis));
			state.sourceText.set(file.displayPath, file.loaded.text);
			continue;
		}
		const result = analyzed[analyzedIndex];
		analyzedIndex += 1;
		if (result !== undefined) storeAnalyzedFile(state, file, result);
	}
}

async function indexFile(
	state: WalkState,
	absolutePath: string,
	displayPath: string,
	explicit: boolean,
	searchPath: string,
): Promise<ToolOutcome<void>> {
	const prepared = await prepareFile(state, absolutePath, displayPath, explicit, searchPath);
	if (isFailed(prepared) || prepared === undefined) return prepared;
	const syntax = languageFromPath(displayPath) !== "text";
	state.offloadParsing = syntax && shouldOffloadGrepParsing({
		fileCount: 1,
		totalBytes: prepared.loaded.size,
		maxFileBytes: prepared.loaded.size,
	});
	const analyzed = await analyzeGrepFile(
		displayPath,
		prepared.loaded.text,
		state.signal,
		state.offloadParsing,
		syntax,
	);
	storeAnalyzedFile(state, prepared, analyzed);
	return;
}

async function prepareFile(
	state: WalkState,
	absolutePath: string,
	displayPath: string,
	explicit: boolean,
	searchPath: string,
): Promise<ToolOutcome<PreparedFile | undefined>> {
	assertNotAborted(state.signal);
	if (explicit) {
		state.scannedFiles += 1;
		state.seenPaths.add(displayPath);
	}

	let info;
	try {
		info = await stat(absolutePath);
	} catch (error) {
		if (explicit) return fail(isAccessDenied(error) ? "ACCESS_DENIED" : "FILE_NOT_FOUND", "File cannot be accessed.", { path: displayPath });
		if (isAccessDenied(error)) state.skipped.access_denied += 1;
		return;
	}
	if (info.size > state.config.limits.grep_max_file_bytes) {
		if (explicit) return fail("OUTPUT_LIMIT_EXCEEDED", "File is too large to search.", { path: displayPath });
		state.skipped.too_large += 1;
		return;
	}
	addScopedFile(state, displayPath, absolutePath);
	if (explicit && state.matchesGlob !== undefined && !state.matchesGlob(path.basename(searchPath)) && !state.matchesGlob(searchPath)) return;
	const activeFilter = state.contentFilter ?? (state.semanticPrefilter ? state.semanticFilter : undefined);

	const cached = state.cache.files.get(displayPath);
	const cacheCurrent = cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs;
	let cachedAnalysis: ParsedCachedFile | undefined;
	if (cacheCurrent) {
		if (isParsedCachedFile(cached)) {
			if (activeFilter === undefined && cached.parserStatus === "parsed") {
				state.files.push(toCandidate(cached));
				return;
			}
			cachedAnalysis = cached;
		}
		if (activeFilter !== undefined && cached.misses.has(activeFilter.key)) return;
	}

	const loaded = await readStableText(absolutePath, displayPath, info, state.signal);
	if (isFailed(loaded)) {
		if (explicit) return loaded;
		if (loaded.error.code === "BINARY_FILE_UNSUPPORTED") state.skipped.binary += 1;
		else if (loaded.error.code === "ENCODING_UNSUPPORTED") state.skipped.invalid_utf8 += 1;
		return;
	}
	if (cachedAnalysis !== undefined) {
		let filterRank: number | undefined;
		if (activeFilter !== undefined) {
			filterRank = activeFilter.evaluate(loaded.text, displayPath);
			if (filterRank === undefined) {
				rememberFilterMiss(state, cached, displayPath, absolutePath, loaded, activeFilter.key);
				return;
			}
		}
		return {
			absolutePath,
			displayPath,
			loaded,
			cachedAnalysis,
			...(state.semanticPrefilter ? { semanticRank: filterRank ?? 0 } : {}),
		};
	}
	let filterRank: number | undefined;
	if (activeFilter !== undefined) {
		filterRank = activeFilter.evaluate(loaded.text, displayPath);
		if (filterRank === undefined) {
			rememberFilterMiss(state, cacheCurrent ? cached : undefined, displayPath, absolutePath, loaded, activeFilter.key);
			return;
		}
	}
	return {
		absolutePath,
		displayPath,
		loaded,
		...(state.semanticPrefilter
			? { semanticRank: filterRank ?? 0 }
			: {}),
	};
}

function rememberFilterMiss(
	state: WalkState,
	cached: CachedFileIndex | undefined,
	displayPath: string,
	absolutePath: string,
	loaded: { size: number; mtimeMs: number },
	filterKey: string,
): void {
	const misses = new Set(cached?.misses ?? []);
	misses.add(filterKey);
	state.cache.files.set(displayPath, {
		...(cached ?? {
			path: displayPath,
			absolutePath,
			realPath: absolutePath,
			size: loaded.size,
			mtimeMs: loaded.mtimeMs,
		}),
		misses,
	});
}

function storeAnalyzedFile(state: WalkState, file: PreparedFile, analyzed: AnalyzedFileIndex): void {
	const { absolutePath, displayPath, loaded } = file;
	const cachedFile: CachedFileIndex & { hash: string; index: ParsedFileIndex; parserStatus: AnalyzedFileIndex["status"] } = {
		path: displayPath,
		absolutePath,
		realPath: absolutePath,
		size: loaded.size,
		mtimeMs: loaded.mtimeMs,
		hash: hashText(loaded.text),
		index: analyzed.index,
		parserStatus: analyzed.status,
		misses: new Set(),
	};
	state.cache.files.set(displayPath, cachedFile);
	state.files.push(toCandidate(cachedFile));
	state.sourceText.set(displayPath, loaded.text);
}

function addScopedFile(state: WalkState, filePath: string, absolutePath: string): void {
	if (state.scopedFilePaths.has(filePath) || state.scopedFiles.length >= state.config.limits.grep_max_files_scanned) return;
	state.scopedFilePaths.add(filePath);
	state.scopedFiles.push({ path: filePath, absolutePath });
}

async function readStableText(
	absolutePath: string,
	displayPath: string,
	initialInfo: Stats,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<{ text: string; size: number; mtimeMs: number }>> {
	let before = initialInfo;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		assertNotAborted(signal);
		let bytes: Buffer;
		try {
			bytes = signal === undefined ? await readFile(absolutePath) : await readFile(absolutePath, { signal });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new AbortGrepIndex();
			return fail(isAccessDenied(error) ? "ACCESS_DENIED" : "FILE_NOT_FOUND", "File cannot be read.", { path: displayPath });
		}
		const after = await stat(absolutePath);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
			before = after;
			continue;
		}
		const decoded = decodeUtf8Text(bytes, displayPath);
		if (isFailed(decoded)) return decoded;
		return { text: decoded, size: after.size, mtimeMs: after.mtimeMs };
	}
	return fail("INVALID_OPERATION", "File changed while grep was indexing it.", { path: displayPath });
}

function toCandidate(cached: ParsedCachedFile): GrepCandidateFile {
	return {
		path: cached.path,
		absolutePath: cached.absolutePath,
		realPath: cached.realPath,
		size: cached.size,
		mtimeMs: cached.mtimeMs,
		contentHash: cached.hash,
		index: cached.index,
		parserStatus: cached.parserStatus,
	};
}

function isParsedCachedFile(cached: CachedFileIndex): cached is ParsedCachedFile {
	return cached.hash !== undefined && cached.index !== undefined && cached.parserStatus !== undefined;
}

function createContentFilter(query: string, match: GrepParams["match"]): ToolOutcome<ContentFilter | undefined> {
	if (match === undefined || match === "auto") return undefined;
	if (match === "literal") {
		return { key: `literal\0${query}`, evaluate: (text) => !query.includes("\n") && text.includes(query) ? 0 : undefined };
	}
	try {
		const expression = new RegExp(query, "gu");
		return {
			key: `regex\0${query}`,
			evaluate: (text) => lines(text).some((line) => {
				const matched = expression.test(line);
				expression.lastIndex = 0;
				return matched;
			}) ? 0 : undefined,
		};
	} catch (error) {
		return fail("INVALID_REGEX", "query is not a valid regular expression.", {
			details: { error: error instanceof Error ? error.message : String(error) },
		});
	}
}

function createSemanticFilter(query: string): ContentFilter {
	const queryLower = query.toLocaleLowerCase();
	const tokens = [...new Set(splitTokens(query).map((token) => token.toLocaleLowerCase()))];
	const identifierLike = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(query);
	const requiredTokens = identifierLike || tokens.length <= 1 ? 1 : Math.min(2, tokens.length);
	const declarationExpression = identifierLike
		? new RegExp(`\\b(?:class|function|interface|type|enum|def|fn)\\s+${escapeRegex(queryLower)}\\b`, "u")
		: undefined;
	return {
		key: `auto\0${queryLower}`,
		evaluate(text, filePath) {
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
			const declaration = exact && declarationExpression?.test(textLower) === true ? 1 : 0;
			return declaration * 1_000_000 + exact * 100_000 + matchedTokens * 10_000 + pathTokens * 1_000 - Math.min(text.length, 999);
		},
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lines(text: string): string[] {
	return text.split(/\n/u);
}

function pruneScopedCache(state: WalkState): void {
	for (const filePath of state.cache.files.keys()) {
		if (!isUnderRoot(state.root.relativePath, filePath)) continue;
		if (!state.seenPaths.has(filePath)) state.cache.files.delete(filePath);
	}
}

function cacheFor(workspaceRoot: string): WorkspaceCache {
	const existing = workspaceCaches.get(workspaceRoot);
	if (existing !== undefined) return existing;
	const created = { files: new Map<string, CachedFileIndex>() };
	workspaceCaches.set(workspaceRoot, created);
	return created;
}

function validateGlob(value: string, rootPath: string): ToolOutcome<string> {
	const glob = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
	if (glob.length === 0) return fail("INVALID_PATH", "glob must not be empty.", { path: rootPath });
	if (glob.includes("\0")) return fail("INVALID_PATH", "glob must not contain NUL bytes.", { path: rootPath });
	if (path.isAbsolute(glob) || /^[A-Za-z]:\//u.test(glob)) return fail("INVALID_PATH", "glob must be relative.", { path: rootPath });
	if (glob.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "glob must not escape path.", { path: rootPath });
	return glob;
}

function compactSkipped(skipped: Required<GrepSkippedFiles>): GrepSkippedFiles {
	const result: GrepSkippedFiles = {};
	if (skipped.binary > 0) result.binary = skipped.binary;
	if (skipped.invalid_utf8 > 0) result.invalid_utf8 = skipped.invalid_utf8;
	if (skipped.access_denied > 0) result.access_denied = skipped.access_denied;
	if (skipped.too_large > 0) result.too_large = skipped.too_large;
	return result;
}

function isRootIgnored(state: WalkState): boolean {
	if (isIgnoredPath(state.config, toolPathIdentity(state.root.relativePath, state.root.realPath, state.root.workspacePath))) return true;
	if (state.root.workspacePath === undefined || state.root.workspacePath === ".") return false;
	return state.ignoreSnapshot.evaluate({ path: state.root.workspacePath, kind: state.root.kind, intent: "index" }).ignored;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isUnderRoot(root: string, filePath: string): boolean {
	return root === "." || filePath === root || filePath.startsWith(`${root}/`);
}

function joinDisplayPath(parent: string, child: string): string {
	if (parent === ".") return child;
	if (path.isAbsolute(parent)) return path.normalize(path.join(parent, child));
	return `${parent}/${child}`;
}

function joinWorkspacePath(parent: string | undefined, child: string): string | undefined {
	if (parent === undefined) return undefined;
	return parent === "." ? child : `${parent}/${child}`;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortGrepIndex();
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

class AbortGrepIndex extends Error {}
