import { stat, unlink } from "node:fs/promises";
import { fail, isFailed } from "./errors.js";
import { parseContextDiff } from "./diff-parser.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import {
	defaultPermissionService,
	defaultPromptContext,
	pathResolveFailure,
	permissionFailure,
	type FileToolPermissionRuntime,
} from "./permission-runtime.js";
import { fileExists, resolveExistingFile, resolveTargetFile, resolveWorkspaceRoot } from "./path-security.js";
import {
	buildTextBytes,
	decodeTextFile,
	joinLogicalLines,
	logicalLines,
	readTextFile,
	sha256Version,
	writeFileAtomic,
} from "./text-file.js";
import type {
	DiffHunk,
	EditOperation,
	EditOperationType,
	EditParams,
	EditSuccess,
	FailedResult,
	OperationResult,
	TargetPath,
	TextFile,
	ToolOutcome,
} from "./types.js";
import type { IgnoreSnapshot } from "./ignore/ignore-types.js";
import { accessesForEdit } from "../permissions/access-extractors.js";

interface OriginalState {
	path: string;
	absolutePath: string;
	exists: boolean;
	bytes: Buffer | null;
	version: string | null;
	mode: number | undefined;
}

interface StagedState {
	path: string;
	absolutePath: string;
	exists: boolean;
	bytes: Buffer | null;
	mode: number | undefined;
	index: number;
	type: EditOperationType;
	oldVersion: string | null;
	from?: string;
	to?: string;
}

export interface EditRuntime {
	writeFileAtomic?: (targetPath: string, bytes: Buffer, mode?: number) => Promise<void>;
	permission?: FileToolPermissionRuntime;
}

/** edit 是唯一写入口：校验结构化 operations、全量暂存，再按逻辑事务提交。 */
export async function editWorkspace(cwd: string, params: unknown, runtime: EditRuntime = {}): Promise<ToolOutcome<EditSuccess>> {
	const input = validateEditInput(params);
	if (isFailed(input)) return input;
	const lexicalConflict = validateLexicalOperationConflicts(input.operations);
	if (lexicalConflict) return lexicalConflict;

	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const permissionService = runtime.permission?.permissionService ?? defaultPermissionService(workspaceRoot);
	let accesses;
	try {
		accesses = await accessesForEdit(permissionService.resourceResolver, input.operations);
	} catch (error) {
		const failure = pathResolveFailure(error);
		if (failure !== undefined) return failure;
		throw error;
	}
	const authorization = await permissionService.authorize({
		toolCallId: runtime.permission?.toolCallId ?? "direct-edit",
		toolName: "edit",
		accesses,
		normalizedToolInput: sanitizeEditInput(input),
		promptContext: runtime.permission?.promptContext ?? defaultPromptContext(),
	});
	if (!authorization.ok) return permissionFailure(authorization);
	if (!(await permissionService.verifyAccessesUnchanged(accesses))) {
		return fail("PERMISSION_CONTEXT_CHANGED", "Permission context changed before editing.", {
			details: { resources: accesses.map((access) => ({ action: access.action, path: access.canonicalPath })) },
		});
	}
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot);
	const staged = await stageOperations(workspaceRoot, input.operations, ignoreSnapshot);
	if (isFailed(staged)) return staged;

	const originals = Array.from(staged.originals.values()).sort((a, b) => a.path.localeCompare(b.path));
	const stagedStates = Array.from(staged.finalStates.values()).sort((a, b) => a.path.localeCompare(b.path));
	const transactionId = `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

	try {
		await commit(stagedStates, runtime.writeFileAtomic ?? writeFileAtomic);
	} catch {
		const rollback = await rollbackOriginals(originals, runtime.writeFileAtomic ?? writeFileAtomic);
		if (!rollback.ok) {
			return fail("TRANSACTION_ROLLBACK_FAILED", "Commit failed and rollback did not fully restore the workspace.", {
				details: { affected_paths: rollback.failedPaths },
			});
		}
		return fail("TRANSACTION_COMMIT_FAILED", "Validation succeeded, but committing file changes failed.", {
			details: { affected_paths: stagedStates.map((state) => state.path) },
		});
	}
	permissionService.consumeOnce(authorization.request);

	return {
		status: "applied",
		transaction_id: transactionId,
		results: operationResults(stagedStates),
		diff: buildDiff(originals, stagedStates),
	};
}

function validateEditInput(params: unknown): ToolOutcome<EditParams> {
	if (!isPlainRecord(params)) {
		return fail("INVALID_OPERATION", "edit input must be an object.");
	}
	const allowedTop = new Set(["operations"]);
	for (const key of Object.keys(params)) {
		if (!allowedTop.has(key)) {
			return fail("INVALID_OPERATION", `Unsupported edit field: ${key}.`, { details: { field: key } });
		}
	}
	const operations = params["operations"];
	if (!Array.isArray(operations)) {
		return fail("INVALID_OPERATION", "operations must be a non-empty array.");
	}
	if (operations.length === 0) {
		return fail("INVALID_OPERATION", "operations must not be empty.");
	}

	const result: EditOperation[] = [];
	for (let index = 0; index < operations.length; index += 1) {
		const operation = validateOperation(operations[index], index);
		if (isFailed(operation)) return operation;
		result.push(operation);
	}
	return { operations: result };
}

function validateOperation(value: unknown, index: number): ToolOutcome<EditOperation> {
	if (!isPlainRecord(value)) {
		return fail("INVALID_OPERATION", "Operation must be an object.", { operation_index: index });
	}
	const type = value["type"];
	if (type === "create_file") {
		const invalid = rejectKeys(value, ["type", "path", "content"], index, type);
		if (invalid) return invalid;
		return requireStrings(value, ["path", "content"], index, type) ?? {
			type,
			path: value["path"] as string,
			content: value["content"] as string,
		};
	}
	if (type === "update_file") {
		const invalid = rejectKeys(value, ["type", "path", "base_version", "diff"], index, type);
		if (invalid) return invalid;
		return requireStrings(value, ["path", "base_version", "diff"], index, type) ?? {
			type,
			path: value["path"] as string,
			base_version: value["base_version"] as string,
			diff: value["diff"] as string,
		};
	}
	if (type === "replace_file") {
		const invalid = rejectKeys(value, ["type", "path", "base_version", "content"], index, type);
		if (invalid) return invalid;
		return requireStrings(value, ["path", "base_version", "content"], index, type) ?? {
			type,
			path: value["path"] as string,
			base_version: value["base_version"] as string,
			content: value["content"] as string,
		};
	}
	if (type === "delete_file") {
		const invalid = rejectKeys(value, ["type", "path", "base_version"], index, type);
		if (invalid) return invalid;
		return requireStrings(value, ["path", "base_version"], index, type) ?? {
			type,
			path: value["path"] as string,
			base_version: value["base_version"] as string,
		};
	}
	if (type === "move_file") {
		const invalid = rejectKeys(value, ["type", "from", "to", "base_version"], index, type);
		if (invalid) return invalid;
		return requireStrings(value, ["from", "to", "base_version"], index, type) ?? {
			type,
			from: value["from"] as string,
			to: value["to"] as string,
			base_version: value["base_version"] as string,
		};
	}
	return fail("INVALID_OPERATION", "Unknown operation type.", {
		operation_index: index,
		details: { type },
	});
}

function rejectKeys(
	value: Record<string, unknown>,
	allowed: string[],
	index: number,
	type: EditOperationType,
): FailedResult | undefined {
	const allowedSet = new Set(allowed);
	const extra = Object.keys(value).find((key) => !allowedSet.has(key));
	if (extra) {
		return fail("INVALID_OPERATION", `Unsupported field for ${type}: ${extra}.`, {
			type,
			operation_index: index,
			details: { field: extra },
		});
	}
	return undefined;
}

function requireStrings(
	value: Record<string, unknown>,
	keys: string[],
	index: number,
	type: EditOperationType,
): FailedResult | undefined {
	for (const key of keys) {
		if (typeof value[key] !== "string") {
			return fail("INVALID_OPERATION", `${type}.${key} must be a string.`, {
				type,
				operation_index: index,
				details: { field: key },
			});
		}
	}
	return undefined;
}

async function stageOperations(
	workspaceRoot: string,
	operations: EditOperation[],
	ignoreSnapshot: IgnoreSnapshot,
): Promise<ToolOutcome<{ originals: Map<string, OriginalState>; finalStates: Map<string, StagedState> }>> {
	const originals = new Map<string, OriginalState>();
	const finalStates = new Map<string, StagedState>();
	const touched = new Map<string, number>();

	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (operation === undefined) continue;

		if (operation.type === "create_file") {
			const target = await resolveTargetFile(workspaceRoot, operation.path);
			if (isFailed(target)) return withOperation(target, index, operation.type);
			noteSoftIgnore(ignoreSnapshot, target.relativePath);
			const conflict = markTouched(touched, target.relativePath, index, operation.type);
			if (conflict) return conflict;
			if (await fileExists(target.absolutePath)) {
				return fail("FILE_ALREADY_EXISTS", "create_file target already exists.", {
					path: target.relativePath,
					type: operation.type,
					operation_index: index,
				});
			}
			originals.set(target.relativePath, originalForMissing(target));
			finalStates.set(target.relativePath, {
				path: target.relativePath,
				absolutePath: target.absolutePath,
				exists: true,
				bytes: Buffer.from(operation.content, "utf8"),
				mode: undefined,
				index,
				type: operation.type,
				oldVersion: null,
			});
			continue;
		}

		if (operation.type === "move_file") {
			const source = await resolveExistingFile(workspaceRoot, operation.from);
			if (isFailed(source)) return withOperation(source, index, operation.type);
			const target = await resolveTargetFile(workspaceRoot, operation.to);
			if (isFailed(target)) return withOperation(target, index, operation.type);
			noteSoftIgnore(ignoreSnapshot, source.relativePath);
			noteSoftIgnore(ignoreSnapshot, target.relativePath);
			const conflict =
				markTouched(touched, source.relativePath, index, operation.type) ??
				markTouched(touched, target.relativePath, index, operation.type);
			if (conflict) return conflict;
			if (await fileExists(target.absolutePath)) {
				return fail("FILE_ALREADY_EXISTS", "move_file target already exists.", {
					path: target.relativePath,
					type: operation.type,
					operation_index: index,
				});
			}
			const sourceFile = await readExistingWithVersion(
				source.realPath,
				source.relativePath,
				operation.base_version,
				index,
				operation.type,
			);
			if (isFailed(sourceFile)) return sourceFile;
			const sourceMode = await modeOf(source.realPath);
			originals.set(source.relativePath, {
				path: source.relativePath,
				absolutePath: source.realPath,
				exists: true,
				bytes: sourceFile.bytes,
				version: sourceFile.version,
				mode: sourceMode,
			});
			originals.set(target.relativePath, originalForMissing(target));
			finalStates.set(source.relativePath, {
				path: source.relativePath,
				absolutePath: source.realPath,
				exists: false,
				bytes: null,
				mode: sourceMode,
				index,
				type: operation.type,
				oldVersion: sourceFile.version,
				from: source.relativePath,
				to: target.relativePath,
			});
			finalStates.set(target.relativePath, {
				path: target.relativePath,
				absolutePath: target.absolutePath,
				exists: true,
				bytes: sourceFile.bytes,
				mode: sourceMode,
				index,
				type: operation.type,
				oldVersion: null,
				from: source.relativePath,
				to: target.relativePath,
			});
			continue;
		}

		const resolved = await resolveExistingFile(workspaceRoot, operation.path);
		if (isFailed(resolved)) return withOperation(resolved, index, operation.type);
		noteSoftIgnore(ignoreSnapshot, resolved.relativePath);
		const conflict = markTouched(touched, resolved.relativePath, index, operation.type);
		if (conflict) return conflict;
		const file = await readExistingWithVersion(
			resolved.realPath,
			resolved.relativePath,
			operation.base_version,
			index,
			operation.type,
		);
		if (isFailed(file)) return file;
		const mode = await modeOf(resolved.realPath);
		originals.set(resolved.relativePath, {
			path: resolved.relativePath,
			absolutePath: resolved.realPath,
			exists: true,
			bytes: file.bytes,
			version: file.version,
			mode,
		});

		if (operation.type === "delete_file") {
			finalStates.set(resolved.relativePath, {
				path: resolved.relativePath,
				absolutePath: resolved.realPath,
				exists: false,
				bytes: null,
				mode,
				index,
				type: operation.type,
				oldVersion: file.version,
			});
		} else if (operation.type === "replace_file") {
			finalStates.set(resolved.relativePath, {
				path: resolved.relativePath,
				absolutePath: resolved.realPath,
				exists: true,
				bytes: buildTextBytes(operation.content, file.hasBom),
				mode,
				index,
				type: operation.type,
				oldVersion: file.version,
			});
		} else {
			const hunks = parseContextDiff(operation.diff, resolved.relativePath, operation.type, index);
			if (isFailed(hunks)) return hunks;
			const updated = applyUpdate(file, hunks, resolved.relativePath, index);
			if (isFailed(updated)) return updated;
			finalStates.set(resolved.relativePath, {
				path: resolved.relativePath,
				absolutePath: resolved.realPath,
				exists: true,
				bytes: buildTextBytes(updated, file.hasBom),
				mode,
				index,
				type: operation.type,
				oldVersion: file.version,
			});
		}
	}

	return { originals, finalStates };
}

function noteSoftIgnore(ignoreSnapshot: IgnoreSnapshot, relativePath: string): void {
	if (!isWorkspaceRelative(relativePath)) return;
	ignoreSnapshot.evaluate({ path: relativePath, kind: "file", intent: "explicit-edit" });
}

function isWorkspaceRelative(value: string): boolean {
	return value === "." || (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value));
}

function sanitizeEditInput(input: EditParams): unknown {
	return {
		operations: input.operations.map((operation) => {
			if (operation.type === "create_file") {
				return { type: operation.type, path: operation.path, content_hash: sha256Version(Buffer.from(operation.content, "utf8")) };
			}
			if (operation.type === "replace_file") {
				return {
					type: operation.type,
					path: operation.path,
					base_version: operation.base_version,
					content_hash: sha256Version(Buffer.from(operation.content, "utf8")),
				};
			}
			if (operation.type === "update_file") {
				return {
					type: operation.type,
					path: operation.path,
					base_version: operation.base_version,
					diff_hash: sha256Version(Buffer.from(operation.diff, "utf8")),
				};
			}
			if (operation.type === "delete_file") {
				return { type: operation.type, path: operation.path, base_version: operation.base_version };
			}
			return { type: operation.type, from: operation.from, to: operation.to, base_version: operation.base_version };
		}),
	};
}

async function readExistingWithVersion(
	absolutePath: string,
	relativePath: string,
	expected: string,
	operationIndex: number,
	type: EditOperationType,
): Promise<ToolOutcome<TextFile>> {
	if (expected === "") {
		return fail("BASE_VERSION_REQUIRED", "Existing file operations require base_version from read.", {
			path: relativePath,
			type,
			operation_index: operationIndex,
		});
	}
	const file = await readTextFile(absolutePath, relativePath);
	if (isFailed(file)) return withOperation(file, operationIndex, type);
	if (expected !== file.version) {
		return fail("STALE_BASE_VERSION", "The file changed after it was read. Read the file again before editing.", {
			path: relativePath,
			type,
			operation_index: operationIndex,
			expected,
			actual: file.version,
		});
	}
	return file;
}

function applyUpdate(file: TextFile, hunks: DiffHunk[], relativePath: string, operationIndex: number): ToolOutcome<string> {
	const parsed = logicalLines(file.text);
	const matches: Array<{ start: number; end: number; hunk: DiffHunk }> = [];

	for (const hunk of hunks) {
		const starts = findExactMatches(parsed.lines, hunk.oldLines);
		if (starts.length === 0) {
			return fail("DIFF_CONTEXT_NOT_FOUND", "Diff hunk context was not found.", {
				path: relativePath,
				type: "update_file",
				operation_index: operationIndex,
				hunk: hunk.index,
			});
		}
		if (starts.length > 1) {
			return fail("DIFF_CONTEXT_AMBIGUOUS", "Diff hunk context matches multiple locations.", {
				path: relativePath,
				type: "update_file",
				operation_index: operationIndex,
				hunk: hunk.index,
				details: { matches: starts.length },
			});
		}
		const start = starts[0];
		if (start === undefined) {
			return fail("DIFF_CONTEXT_NOT_FOUND", "Diff hunk context was not found.", {
				path: relativePath,
				type: "update_file",
				operation_index: operationIndex,
				hunk: hunk.index,
			});
		}
		matches.push({ start, end: start + hunk.oldLines.length, hunk });
	}

	matches.sort((a, b) => a.start - b.start);
	for (let index = 1; index < matches.length; index += 1) {
		const previous = matches[index - 1];
		const current = matches[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end) {
			return fail("DIFF_OVERLAPPING_HUNKS", "Diff hunks overlap.", {
				path: relativePath,
				type: "update_file",
				operation_index: operationIndex,
				hunk: current.hunk.index,
			});
		}
	}

	const output: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		output.push(...parsed.lines.slice(cursor, match.start));
		output.push(...match.hunk.newLines);
		cursor = match.end;
	}
	output.push(...parsed.lines.slice(cursor));

	const newline = file.newline === "crlf" ? "\r\n" : "\n";
	return joinLogicalLines(output, newline, parsed.finalNewline);
}

function findExactMatches(lines: string[], needle: string[]): number[] {
	const matches: number[] = [];
	if (needle.length === 0 || needle.length > lines.length) return matches;
	for (let index = 0; index <= lines.length - needle.length; index += 1) {
		let same = true;
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (lines[index + offset] !== needle[offset]) {
				same = false;
				break;
			}
		}
		if (same) matches.push(index);
	}
	return matches;
}

function originalForMissing(target: TargetPath): OriginalState {
	return {
		path: target.relativePath,
		absolutePath: target.absolutePath,
		exists: false,
		bytes: null,
		version: null,
		mode: undefined,
	};
}

function markTouched(
	touched: Map<string, number>,
	relativePath: string,
	index: number,
	type: EditOperationType,
): FailedResult | undefined {
	const key = relativePath.toLocaleLowerCase();
	const previous = touched.get(key);
	if (previous !== undefined) {
		return fail("CONFLICTING_OPERATIONS", "Multiple operations target the same logical path.", {
			path: relativePath,
			type,
			operation_index: index,
			details: { previous_operation_index: previous },
		});
	}
	touched.set(key, index);
	return undefined;
}

function validateLexicalOperationConflicts(operations: EditOperation[]): FailedResult | undefined {
	const touched = new Map<string, number>();
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (operation === undefined) continue;
		const paths = operation.type === "move_file" ? [operation.from, operation.to] : [operation.path];
		for (const candidate of paths) {
			const key = candidate.replace(/\\/g, "/").toLocaleLowerCase();
			const previous = touched.get(key);
			if (previous !== undefined) {
				return fail("CONFLICTING_OPERATIONS", "Multiple operations target the same logical path.", {
					path: candidate,
					type: operation.type,
					operation_index: index,
					details: { previous_operation_index: previous },
				});
			}
			touched.set(key, index);
		}
	}
	return undefined;
}

async function modeOf(absolutePath: string): Promise<number | undefined> {
	try {
		const info = await stat(absolutePath);
		return info.mode;
	} catch {
		return undefined;
	}
}

async function commit(states: StagedState[], writer: (targetPath: string, bytes: Buffer, mode?: number) => Promise<void>): Promise<void> {
	for (const state of states) {
		if (state.exists) {
			const bytes = state.bytes;
			if (bytes === null) throw new Error("staged write missing bytes");
			await writer(state.absolutePath, bytes, state.mode);
		} else {
			await unlink(state.absolutePath);
		}
	}
}

async function rollbackOriginals(
	originals: OriginalState[],
	writer: (targetPath: string, bytes: Buffer, mode?: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; failedPaths: string[] }> {
	const failedPaths: string[] = [];
	for (const original of originals) {
		try {
			if (original.exists) {
				const bytes = original.bytes;
				if (bytes === null) throw new Error("original bytes missing");
				await writer(original.absolutePath, bytes, original.mode);
			} else if (await fileExists(original.absolutePath)) {
				await unlink(original.absolutePath);
			}
		} catch {
			failedPaths.push(original.path);
		}
	}
	return failedPaths.length === 0 ? { ok: true } : { ok: false, failedPaths };
}

function operationResults(states: StagedState[]): OperationResult[] {
	const grouped = new Map<number, StagedState[]>();
	for (const state of states) {
		const list = grouped.get(state.index) ?? [];
		list.push(state);
		grouped.set(state.index, list);
	}
	return Array.from(grouped.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([index, list]) => resultForOperation(index, list));
}

function resultForOperation(index: number, states: StagedState[]): OperationResult {
	const first = states[0];
	if (first === undefined) {
		return { index, type: "create_file", old_version: null, new_version: null };
	}
	if (first.type === "move_file") {
		const created = states.find((state) => state.exists);
		const deleted = states.find((state) => !state.exists);
		const result: OperationResult = {
			index,
			type: "move_file",
			old_version: deleted?.oldVersion ?? null,
			new_version: created?.bytes ? sha256Version(created.bytes) : null,
		};
		if (first.from !== undefined) result.from = first.from;
		if (first.to !== undefined) result.to = first.to;
		return result;
	}
	return {
		index,
		type: first.type,
		path: first.path,
		old_version: first.oldVersion,
		new_version: first.exists && first.bytes ? sha256Version(first.bytes) : null,
	};
}

function buildDiff(originals: OriginalState[], states: StagedState[]): string {
	const originalMap = new Map(originals.map((state) => [state.path, state]));
	const chunks: string[] = [];
	for (const state of states) {
		const original = originalMap.get(state.path);
		const oldText = original?.bytes ? textForDiff(original.bytes) : "";
		const newText = state.bytes ? textForDiff(state.bytes) : "";
		chunks.push(`--- a/${state.path}`);
		chunks.push(`+++ b/${state.path}`);
		chunks.push(`@@ -1,${lineCount(oldText)} +1,${lineCount(newText)} @@`);
		if (oldText !== "") {
			for (const line of oldText.split("\n")) chunks.push(`-${line}`);
		}
		if (newText !== "") {
			for (const line of newText.split("\n")) chunks.push(`+${line}`);
		}
	}
	return chunks.join("\n");
}

function textForDiff(bytes: Buffer): string {
	const decoded = decodeTextFile(bytes, "<diff>");
	if (isFailed(decoded)) return "";
	return decoded.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
}

function lineCount(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withOperation<T extends FailedResult>(result: T, operationIndex: number, type: EditOperationType): T {
	if (result.error.operation_index === undefined) result.error.operation_index = operationIndex;
	if (result.error.type === undefined) result.error.type = type;
	return result;
}
