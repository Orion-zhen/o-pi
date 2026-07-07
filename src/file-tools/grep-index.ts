import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "./config.js";
import { fail, isFailed } from "./errors.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "./ignore/ignore-types.js";
import { parseCodeUnits, type ParsedFileIndex } from "./grep-parser.js";
import { guardExistingPath, PathGuardBlockedError } from "../safety/path-guard.js";
import { normalizeToolPath } from "./path-resolver.js";
import { decodeTextFile } from "./text-file.js";
import type { GrepParams, GrepSkippedFiles, ToolOutcome } from "./types.js";

export interface GrepCandidateFile {
	path: string;
	absolutePath: string;
	realPath: string;
	size: number;
	mtimeMs: number;
	index: ParsedFileIndex;
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
	sourceText: Map<string, string>;
	skipped: GrepSkippedFiles;
	scanComplete: boolean;
}

interface WorkspaceCache {
	files: Map<string, CachedFileIndex>;
}

interface CachedFileIndex {
	path: string;
	absolutePath: string;
	realPath: string;
	size: number;
	mtimeMs: number;
	hash: string;
	index: ParsedFileIndex;
}

interface WalkState {
	workspaceRoot: string;
	root: GrepSearchRoot;
	config: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	matchesGlob?: (candidate: string) => boolean;
	signal?: AbortSignal;
	files: GrepCandidateFile[];
	sourceText: Map<string, string>;
	skipped: Required<GrepSkippedFiles>;
	scannedFiles: number;
	scanComplete: boolean;
	seenPaths: Set<string>;
	cache: WorkspaceCache;
}

const workspaceCaches = new Map<string, WorkspaceCache>();

/** 构建或复用 workspace 进程内索引；缓存只保存元数据和 token，不保存完整源码。 */
export async function getGrepIndex(cwd: string, params: Pick<GrepParams, "path" | "glob">, signal?: AbortSignal): Promise<ToolOutcome<GrepIndexResult>> {
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = path.resolve(cwd);
	const root = await resolveGrepRoot(workspaceRoot, params.path ?? ".", config);
	if (isFailed(root)) return root;
	const glob = params.glob === undefined ? undefined : validateGlob(params.glob, root.relativePath);
	if (isFailed(glob)) return glob;
	const matchesGlob = glob === undefined ? undefined : picomatch(glob, { dot: true, nonegate: true });
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	const cache = cacheFor(workspaceRoot);
	const state: WalkState = {
		workspaceRoot,
		root,
		config,
		ignoreSnapshot,
		...(matchesGlob !== undefined ? { matchesGlob } : {}),
		...(signal !== undefined ? { signal } : {}),
		files: [],
		sourceText: new Map(),
		skipped: { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0 },
		scannedFiles: 0,
		scanComplete: true,
		seenPaths: new Set(),
		cache,
	};

	try {
		assertNotAborted(signal);
		if (root.kind === "file") {
			const indexed = await indexFile(state, root.realPath, root.relativePath, root.workspacePath, true, root.relativePath);
			if (isFailed(indexed)) return indexed;
		} else {
			await walkDirectory(state, root.realPath, root.relativePath, root.workspacePath, ".");
		}
	} catch (error) {
		if (error instanceof AbortGrepIndex) return fail("OPERATION_ABORTED", "grep was aborted.", { path: root.relativePath });
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
		sourceText: state.sourceText,
		skipped: compactSkipped(state.skipped),
		scanComplete: state.scanComplete,
	};
}

export function clearGrepIndexForTests(): void {
	workspaceCaches.clear();
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
		if (error instanceof PathGuardBlockedError) return blockedPathFailure(lexical.relativePath, error);
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
): Promise<void> {
	assertNotAborted(state.signal);
	if (!state.scanComplete) return;
	if (isBlockedPath(state.config, toolPathIdentity(displayDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (isIgnoredPath(state.config, toolPathIdentity(displayDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (workspaceDirectory !== undefined && workspaceDirectory !== ".") {
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
			const decision = childWorkspacePath === undefined
				? { ignored: false, prune: false }
				: state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "directory", intent: "index" });
			if (isIgnoredPath(state.config, identity) || (decision.ignored && decision.prune)) continue;
			await walkDirectory(state, childAbsolutePath, childDisplayPath, childWorkspacePath, childSearchPath);
			continue;
		}
		if (!entry.isFile()) continue;
		if (state.matchesGlob !== undefined && !state.matchesGlob(childSearchPath)) continue;
		if (isIgnoredPath(state.config, identity)) continue;
		const decision = childWorkspacePath === undefined ? { ignored: false } : state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "file", intent: "index" });
		if (decision.ignored) continue;
		await indexFile(state, childAbsolutePath, childDisplayPath, childWorkspacePath, false, childSearchPath);
	}
}

async function indexFile(
	state: WalkState,
	absolutePath: string,
	displayPath: string,
	workspacePath: string | undefined,
	explicit: boolean,
	searchPath: string,
): Promise<ToolOutcome<void>> {
	assertNotAborted(state.signal);
	if (state.scannedFiles >= state.config.limits.grep_max_files_scanned) {
		state.scanComplete = false;
		return;
	}
	state.scannedFiles += 1;
	state.seenPaths.add(displayPath);

	if (explicit) {
		if (state.matchesGlob !== undefined && !state.matchesGlob(path.basename(searchPath)) && !state.matchesGlob(searchPath)) return;
		if (isIgnoredPath(state.config, toolPathIdentity(displayPath, absolutePath, workspacePath))) {
			return fail("PROTECTED_PATH", "Path is ignored for search.", { path: displayPath });
		}
		if (workspacePath !== undefined) {
			const decision = state.ignoreSnapshot.evaluate({ path: workspacePath, kind: "file", intent: "index" });
			if (decision.ignored) return fail("PROTECTED_PATH", "Path is ignored for search.", { path: displayPath });
		}
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

	const cached = state.cache.files.get(displayPath);
	if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
		state.files.push(toCandidate(cached));
		return;
	}

	const loaded = await readStableText(absolutePath, displayPath, state.signal);
	if (isFailed(loaded)) {
		if (explicit) return loaded;
		if (loaded.error.code === "BINARY_FILE_UNSUPPORTED") state.skipped.binary += 1;
		else if (loaded.error.code === "ENCODING_UNSUPPORTED") state.skipped.invalid_utf8 += 1;
		return;
	}
	const parsed = parseCodeUnits(displayPath, loaded.text);
	const cachedFile: CachedFileIndex = {
		path: displayPath,
		absolutePath,
		realPath: absolutePath,
		size: loaded.size,
		mtimeMs: loaded.mtimeMs,
		hash: hashText(loaded.text),
		index: parsed,
	};
	state.cache.files.set(displayPath, cachedFile);
	state.files.push(toCandidate(cachedFile));
	state.sourceText.set(displayPath, loaded.text);
}

async function readStableText(
	absolutePath: string,
	displayPath: string,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<{ text: string; size: number; mtimeMs: number }>> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		assertNotAborted(signal);
		const before = await stat(absolutePath);
		let bytes: Buffer;
		try {
			bytes = signal === undefined ? await readFile(absolutePath) : await readFile(absolutePath, { signal });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new AbortGrepIndex();
			return fail(isAccessDenied(error) ? "ACCESS_DENIED" : "FILE_NOT_FOUND", "File cannot be read.", { path: displayPath });
		}
		const after = await stat(absolutePath);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
		const decoded = decodeTextFile(bytes, displayPath);
		if (isFailed(decoded)) return decoded;
		return { text: decoded.text, size: after.size, mtimeMs: after.mtimeMs };
	}
	return fail("INVALID_OPERATION", "File changed while grep was indexing it.", { path: displayPath });
}

function toCandidate(cached: CachedFileIndex): GrepCandidateFile {
	return {
		path: cached.path,
		absolutePath: cached.absolutePath,
		realPath: cached.realPath,
		size: cached.size,
		mtimeMs: cached.mtimeMs,
		index: cached.index,
	};
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

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function isUnderRoot(root: string, filePath: string): boolean {
	return root === "." || filePath === root || filePath.startsWith(`${root}/`);
}

function normalizeRelative(value: string): string {
	return value.replace(/\\/g, "/") || ".";
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

function blockedPathFailure(displayPath: string, error: PathGuardBlockedError): ToolOutcome<never> {
	return fail("PROTECTED_PATH", error.block.message, {
		path: displayPath,
		details: {
			code: error.block.code,
			...(error.block.matched_rule !== undefined ? { matched_rule: error.block.matched_rule } : {}),
			...(error.block.matched_path !== undefined ? { matched_path: error.block.matched_path } : {}),
		},
	});
}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
