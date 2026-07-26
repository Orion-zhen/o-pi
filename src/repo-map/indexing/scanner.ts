import pLimit from "p-limit";

import type { FileRef } from "../../filesystem/contracts/path.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { createFileIdentity } from "../../code-index/identity.js";
import { RepoMapError, throwIfAborted } from "../core/errors.js";
import type { RepoMapDiagnostic, RepoMapFileRecord, RepoMapScanSummary } from "../core/types.js";

export interface RepoMapScanInput {
	filesystem: RepoMapScannerFileSystem;
	operation: FsOperationContext;
	maxFiles: number;
	maxFileBytes: number;
	concurrency: number;
	previousFiles?: readonly RepoMapFileRecord[];
	signal?: AbortSignal;
	onProgress?: (progress: RepoMapProgress) => void;
}

export type RepoMapScannerFileSystem = Pick<
	WorkspaceFileSystem,
	"root" | "traversal" | "metadata" | "content" | "visibility"
>;

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

interface Candidate {
	ref?: FileRef;
	relativePath: string;
}

export async function scanRepoMap(input: RepoMapScanInput): Promise<RepoMapScanResult> {
	throwIfAborted(input.signal);
	safeProgress(input.onProgress, { phase: "discovering" });
	const candidates: Candidate[] = [];
	const diagnostics: RepoMapDiagnostic[] = input.filesystem.visibility.snapshot.diagnostics.map((diagnostic) => ({
		code: diagnostic.code,
		message: diagnostic.message,
		path: diagnostic.sourcePath,
	}));
	let skippedDirectories = 0;
	const traversal = await input.filesystem.traversal.walk(input.filesystem.root, {
		intent: "index",
		explicitRoot: false,
	}, input.operation);
	if (!traversal.ok) throw scanFailure(traversal.error);
	try {
		for await (const event of traversal.value) {
			throwIfAborted(input.signal);
			if (event.type === "skip") {
				if (event.kind === "directory") skippedDirectories += 1;
				continue;
			}
			if (event.type === "error") {
				if (event.kind === "file") {
					candidates.push({ relativePath: event.path });
					if (candidates.length > input.maxFiles) {
						throw new RepoMapError("SCAN_LIMIT_EXCEEDED", `Repo Map scan exceeds the ${input.maxFiles} file limit.`);
					}
				} else {
					skippedDirectories += 1;
					diagnostics.push({ code: "DIRECTORY_UNREADABLE", message: "Directory could not be read.", path: event.path });
				}
				continue;
			}
			if (event.ref.kind !== "file") continue;
			const relativePath = event.ref.workspacePath;
			if (relativePath === undefined || relativePath === ".") continue;
			candidates.push({ ref: event.ref, relativePath });
			if (candidates.length > input.maxFiles) {
				throw new RepoMapError("SCAN_LIMIT_EXCEEDED", `Repo Map scan exceeds the ${input.maxFiles} file limit.`);
			}
		}
	} finally {
		await traversal.value.close();
	}

	candidates.sort((left, right) => compareStable(left.relativePath, right.relativePath));
	safeProgress(input.onProgress, { phase: "scanning", completed: 0, total: candidates.length });
	const previous = new Map((input.previousFiles ?? []).map((record) => [record.path, record]));
	let reused = 0;
	let hashed = 0;
	let completed = 0;
	const limit = pLimit(input.concurrency);
	const records = await limit.map(candidates, async (candidate) => {
		throwIfAborted(input.signal);
		const result = await buildRecord(candidate, previous.get(candidate.relativePath), input.maxFileBytes, input);
		if (result.reused) reused += 1;
		if (result.hashed) hashed += 1;
		if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
		completed += 1;
		safeProgress(input.onProgress, { phase: "hashing", completed, total: candidates.length });
		return result.record;
	});
	throwIfAborted(input.signal);

	const currentPaths = new Set(records.map((record) => record.path));
	let added = 0;
	let changed = 0;
	for (const record of records) {
		const oldRecord = previous.get(record.path);
		if (oldRecord === undefined) added += 1;
		else if (!recordsEqual(record, oldRecord)) changed += 1;
	}
	let removed = 0;
	for (const oldPath of previous.keys()) if (!currentPaths.has(oldPath)) removed += 1;
	const indexed = records.filter((record) => record.status === "indexed").length;
	const tooLarge = records.filter((record) => record.status === "too_large").length;
	const unreadable = records.filter((record) => record.status === "unreadable").length;
	const unstable = records.filter((record) => record.status === "unstable").length;
	const summary: RepoMapScanSummary = {
		discovered: records.length,
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
	return { files: records, diagnostics, summary };
}

async function buildRecord(
	candidate: Candidate,
	previous: RepoMapFileRecord | undefined,
	maxBytes: number,
	input: RepoMapScanInput,
): Promise<{ record: RepoMapFileRecord; reused: boolean; hashed: boolean; diagnostic?: RepoMapDiagnostic }> {
	const identity = createFileIdentity(candidate.relativePath);
	if (candidate.ref === undefined) return unreadableRecord(identity, candidate.relativePath);
	const metadata = await input.filesystem.metadata.stat(candidate.ref, input.operation);
	if (!metadata.ok) return unreadableRecord(identity, candidate.relativePath);
	const base = { size: metadata.value.sizeBytes, mtimeMs: metadata.value.modifiedAtMs };
	if (metadata.value.sizeBytes > maxBytes) {
		return { record: { ...identity, ...base, status: "too_large" }, reused: false, hashed: false };
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const content = await input.filesystem.content.readBytes(candidate.ref, { maxBytes, stable: true }, input.operation);
		if (content.ok) {
			const after = await input.filesystem.metadata.stat(candidate.ref, input.operation);
			if (!after.ok) return unreadableRecord(identity, candidate.relativePath, base);
			if (after.value.sizeBytes > maxBytes) {
				return { record: { ...identity, size: after.value.sizeBytes, mtimeMs: after.value.modifiedAtMs, status: "too_large" }, reused: false, hashed: false };
			}
			if (after.value.sizeBytes !== content.value.sizeBytes) continue;
			const contentHash = content.value.hash.replace(/^sha256:/u, "");
			const reused = previous?.status === "indexed" && previous.contentHash === contentHash;
			return {
				record: { ...identity, size: content.value.sizeBytes, mtimeMs: after.value.modifiedAtMs, status: "indexed", contentHash },
				reused,
				hashed: !reused,
			};
		}
		if (content.error.code === "aborted") throw new RepoMapError("OPERATION_ABORTED", "Repo Map initialization cancelled.", content.error);
		if (content.error.code === "too-large") {
			return { record: { ...identity, ...base, status: "too_large" }, reused: false, hashed: false };
		}
		if (content.error.code !== "changed-during-read") return unreadableRecord(identity, candidate.relativePath, base);
	}
	return {
		record: { ...identity, ...base, status: "unstable" },
		reused: false,
		hashed: false,
		diagnostic: { code: "FILE_UNSTABLE", message: "File changed repeatedly while being read.", path: candidate.relativePath },
	};
}

function unreadableRecord(
	identity: ReturnType<typeof createFileIdentity>,
	path: string,
	metadata: { size: number; mtimeMs: number } = { size: 0, mtimeMs: 0 },
): { record: RepoMapFileRecord; reused: false; hashed: false; diagnostic: RepoMapDiagnostic } {
	return {
		record: { ...identity, ...metadata, status: "unreadable" },
		reused: false,
		hashed: false,
		diagnostic: { code: "FILE_UNREADABLE", message: "File content could not be read.", path },
	};
}

function recordsEqual(left: RepoMapFileRecord, right: RepoMapFileRecord): boolean {
	return left.id === right.id
		&& left.path === right.path
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.status === right.status
		&& left.contentHash === right.contentHash;
}

function scanFailure(error: { readonly code: string; readonly message: string }): RepoMapError {
	return new RepoMapError(error.code === "aborted" ? "OPERATION_ABORTED" : "SCAN_FAILED", error.message, error);
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
