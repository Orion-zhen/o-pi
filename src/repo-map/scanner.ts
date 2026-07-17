import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { constants, type Dirent, type Stats } from "node:fs";

import { createFileIdentity } from "../code-index/identity.js";
import {
	isBlockedPath,
	isIgnoredPath,
	toolPathIdentity,
	type FileToolsConfig,
} from "../file-tools/config.js";
import type { IgnoreSnapshot } from "../file-tools/ignore/ignore-types.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import type { RepoMapDiagnostic, RepoMapFileRecord, RepoMapScanSummary } from "./types.js";

export interface RepoMapScanInput {
	root: string;
	fileToolsConfig: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	maxFiles: number;
	maxFileBytes: number;
	concurrency: number;
	previousFiles?: readonly RepoMapFileRecord[];
	signal?: AbortSignal;
	onProgress?: (progress: RepoMapProgress) => void;
	fileSystem?: ScannerFileSystem;
}

export interface RepoMapProgress {
	phase: "discovering" | "scanning" | "hashing" | "parsing" | "saving";
	completed?: number;
	total?: number;
}

export interface RepoMapScanResult {
	files: RepoMapFileRecord[];
	diagnostics: RepoMapDiagnostic[];
	summary: RepoMapScanSummary;
}

export interface ScannerFileSystem {
	readdir(directory: string): Promise<Dirent[]>;
	lstat(filePath: string): Promise<Stats>;
	stat(filePath: string): Promise<Stats>;
	readFile(filePath: string, signal: AbortSignal | undefined, maxBytes: number): Promise<Buffer>;
}

interface Candidate {
	absolutePath: string;
	relativePath: string;
	initialStat?: Stats;
}

const defaultFileSystem: ScannerFileSystem = {
	async readdir(directory) {
		return await readdir(directory, { withFileTypes: true });
	},
	async lstat(filePath) {
		return await lstat(filePath);
	},
	async stat(filePath) {
		return await lstat(filePath);
	},
	async readFile(filePath, signal, maxBytes) {
		const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const buffer = Buffer.allocUnsafe(maxBytes + 1);
			let offset = 0;
			while (offset < buffer.length) {
				throwIfAborted(signal);
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			return buffer.subarray(0, offset);
		} finally {
			await handle.close();
		}
	},
};

export async function scanRepoMap(input: RepoMapScanInput): Promise<RepoMapScanResult> {
	throwIfAborted(input.signal);
	safeProgress(input.onProgress, { phase: "discovering" });
	const fileSystem = input.fileSystem ?? defaultFileSystem;
	const candidates: Candidate[] = [];
	const diagnostics: RepoMapDiagnostic[] = input.ignoreSnapshot.diagnostics.map((diagnostic) => ({
		code: diagnostic.code,
		message: diagnostic.message,
		path: diagnostic.sourcePath,
	}));
	let skippedDirectories = 0;

	const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
		throwIfAborted(input.signal);
		if (relativeDirectory !== ".") {
			try {
				const directoryInfo = await fileSystem.lstat(absoluteDirectory);
				if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
					skippedDirectories += 1;
					return;
				}
			} catch {
				skippedDirectories += 1;
				return;
			}
		}
		let entries: Dirent[];
		try {
			entries = await fileSystem.readdir(absoluteDirectory);
		} catch {
			skippedDirectories += 1;
			diagnostics.push({ code: "DIRECTORY_UNREADABLE", message: "Directory could not be read.", path: relativeDirectory });
			return;
		}
		entries.sort((left, right) => compareStable(left.name, right.name));
		for (const entry of entries) {
			throwIfAborted(input.signal);
			const relativePath = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
			const absolutePath = path.join(absoluteDirectory, entry.name);
			const identity = toolPathIdentity(relativePath, absolutePath, relativePath);
			if (isBlockedPath(input.fileToolsConfig, identity)) {
				if (entry.isDirectory()) skippedDirectories += 1;
				continue;
			}
			if (entry.isSymbolicLink()) {
				if (await symlinkIsDirectory(fileSystem, absolutePath)) skippedDirectories += 1;
				continue;
			}
			if (entry.isDirectory()) {
				if (entry.name === ".git" || isIgnoredPath(input.fileToolsConfig, identity)) {
					skippedDirectories += 1;
					continue;
				}
				const decision = input.ignoreSnapshot.evaluate({ path: relativePath, kind: "directory", intent: "index" });
				if (decision.ignored && decision.prune) {
					skippedDirectories += 1;
					continue;
				}
				await walk(absolutePath, relativePath);
				continue;
			}
			if (!entry.isFile() || isIgnoredPath(input.fileToolsConfig, identity)) continue;
			if (input.ignoreSnapshot.evaluate({ path: relativePath, kind: "file", intent: "index" }).ignored) continue;
			let initialStat: Stats | undefined;
			try {
				initialStat = await fileSystem.stat(absolutePath);
				if (!initialStat.isFile()) continue;
			} catch {
				// Dirent established file existence; retain an unreadable record below.
			}
			candidates.push({ absolutePath, relativePath, ...(initialStat !== undefined ? { initialStat } : {}) });
			if (candidates.length > input.maxFiles) {
				throw new RepoMapError("SCAN_LIMIT_EXCEEDED", `Repo Map scan exceeds the ${input.maxFiles} file limit.`);
			}
		}
	};

	await walk(input.root, ".");
	candidates.sort((left, right) => compareStable(left.relativePath, right.relativePath));
	safeProgress(input.onProgress, { phase: "scanning", completed: 0, total: candidates.length });
	const previous = new Map((input.previousFiles ?? []).map((record) => [record.path, record]));
	const records = new Array<RepoMapFileRecord | undefined>(candidates.length);
	let reused = 0;
	let hashed = 0;
	let completed = 0;
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			throwIfAborted(input.signal);
			const index = nextIndex;
			if (index >= candidates.length) return;
			nextIndex += 1;
			const candidate = candidates[index];
			if (candidate === undefined) return;
			const oldRecord = previous.get(candidate.relativePath);
			const result = await buildRecord(candidate, oldRecord, input.maxFileBytes, fileSystem, input.signal);
			records[index] = result.record;
			if (result.reused) reused += 1;
			if (result.hashed) hashed += 1;
			if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
			completed += 1;
			safeProgress(input.onProgress, { phase: "hashing", completed, total: candidates.length });
		}
	};
	const workerResults = await Promise.allSettled(
		Array.from({ length: Math.min(input.concurrency, Math.max(1, candidates.length)) }, () => worker()),
	);
	const workerFailure = workerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (workerFailure !== undefined) throw workerFailure.reason;
	throwIfAborted(input.signal);

	const files = records.filter((record): record is RepoMapFileRecord => record !== undefined);
	const currentPaths = new Set(files.map((record) => record.path));
	let added = 0;
	let changed = 0;
	for (const record of files) {
		const oldRecord = previous.get(record.path);
		if (oldRecord === undefined) added += 1;
		else if (!recordsEqual(record, oldRecord)) changed += 1;
	}
	let removed = 0;
	for (const oldPath of previous.keys()) if (!currentPaths.has(oldPath)) removed += 1;
	const indexed = files.filter((record) => record.status === "indexed").length;
	const tooLarge = files.filter((record) => record.status === "too_large").length;
	const unreadable = files.filter((record) => record.status === "unreadable").length;
	const unstable = files.filter((record) => record.status === "unstable").length;
	const summary: RepoMapScanSummary = {
		discovered: files.length,
		indexed,
		reused,
		hashed,
		added,
		changed,
		removed,
		tooLarge,
		unreadable,
		unstable,
		parsed: 0,
		unsupported: 0,
		parseErrors: 0,
		reusedParsed: 0,
		symbols: 0,
		testNodes: 0,
		edges: 0,
		skippedDirectories,
		diagnostics: diagnostics.length,
	};
	return { files, diagnostics, summary };
}

async function buildRecord(
	candidate: Candidate,
	previous: RepoMapFileRecord | undefined,
	maxBytes: number,
	fileSystem: ScannerFileSystem,
	signal?: AbortSignal,
): Promise<{ record: RepoMapFileRecord; reused: boolean; hashed: boolean; diagnostic?: RepoMapDiagnostic }> {
	const identity = createFileIdentity(candidate.relativePath);
	const info = candidate.initialStat;
	if (info === undefined) {
		return {
			record: { ...identity, size: 0, mtimeMs: 0, status: "unreadable" },
			reused: false,
			hashed: false,
			diagnostic: { code: "FILE_UNREADABLE", message: "File metadata could not be read.", path: candidate.relativePath },
		};
	}
	if (info.size > maxBytes) {
		return { record: { ...identity, size: info.size, mtimeMs: info.mtimeMs, status: "too_large" }, reused: false, hashed: false };
	}
	if (
		previous?.status === "indexed"
		&& previous.size === info.size
		&& previous.mtimeMs === info.mtimeMs
		&& previous.contentHash !== undefined
	) {
		return { record: { ...identity, size: info.size, mtimeMs: info.mtimeMs, status: "indexed", contentHash: previous.contentHash }, reused: true, hashed: false };
	}
	try {
		const stable = await stableRead(candidate.absolutePath, maxBytes, fileSystem, signal);
		if (stable === undefined) {
			return {
				record: { ...identity, size: info.size, mtimeMs: info.mtimeMs, status: "unstable" },
				reused: false,
				hashed: false,
				diagnostic: { code: "FILE_UNSTABLE", message: "File changed repeatedly while being read.", path: candidate.relativePath },
			};
		}
		if (stable.kind === "too_large") {
			return {
				record: { ...identity, size: stable.info.size, mtimeMs: stable.info.mtimeMs, status: "too_large" },
				reused: false,
				hashed: false,
			};
		}
		return {
			record: {
				...identity,
				size: stable.info.size,
				mtimeMs: stable.info.mtimeMs,
				status: "indexed",
				contentHash: createHash("sha256").update(stable.bytes).digest("hex"),
			},
			reused: false,
			hashed: true,
		};
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) throw new RepoMapError("OPERATION_ABORTED", "Repo Map initialization cancelled.", error);
		return {
			record: { ...identity, size: info.size, mtimeMs: info.mtimeMs, status: "unreadable" },
			reused: false,
			hashed: false,
			diagnostic: { code: "FILE_UNREADABLE", message: "File content could not be read.", path: candidate.relativePath },
		};
	}
}

async function stableRead(
	filePath: string,
	maxBytes: number,
	fileSystem: ScannerFileSystem,
	signal?: AbortSignal,
): Promise<{ kind: "stable"; bytes: Buffer; info: Stats } | { kind: "too_large"; info: Stats } | undefined> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		throwIfAborted(signal);
		const before = await fileSystem.stat(filePath);
		if (before.size > maxBytes) return { kind: "too_large", info: before };
		const bytes = await fileSystem.readFile(filePath, signal, maxBytes);
		const after = await fileSystem.stat(filePath);
		if (after.size > maxBytes || bytes.length > maxBytes) return { kind: "too_large", info: after };
		if (before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === after.size) return { kind: "stable", bytes, info: after };
	}
	return undefined;
}

async function symlinkIsDirectory(fileSystem: ScannerFileSystem, absolutePath: string): Promise<boolean> {
	try {
		return (await fileSystem.lstat(absolutePath)).isDirectory();
	} catch {
		return false;
	}
}

function recordsEqual(left: RepoMapFileRecord, right: RepoMapFileRecord): boolean {
	return left.id === right.id
		&& left.path === right.path
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.status === right.status
		&& left.contentHash === right.contentHash;
}

function safeProgress(callback: RepoMapScanInput["onProgress"], progress: RepoMapProgress): void {
	try {
		callback?.(progress);
	} catch {
		// UI progress is best effort and cannot affect indexing.
	}
}

function compareStable(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
