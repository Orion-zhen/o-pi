import { writeFile } from "node:fs/promises";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { fail, isFailed } from "./errors.js";
import { ignoreConfigFromFileTools, loadFileToolsConfig } from "./config.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import { resolveExistingFile, resolveWorkspaceRoot } from "./path-resolver.js";
import type { ReadVersionCache } from "./read-cache.js";
import { buildTextBytes, readTextFile, sha256Version } from "./text-file.js";
import type { EditParams, EditPreviewSuccess, EditReplacement, EditSuccess, FailedResult, TextFile, ToolOutcome } from "./types.js";
import type { IgnoreSnapshot } from "./ignore/ignore-types.js";

interface PreparedEdit {
	path: string;
	absolutePath: string;
	file: TextFile;
	updatedText: string;
	replacements: number;
}

interface MatchedReplacement {
	index: number;
	start: number;
	end: number;
	replacement: EditReplacement;
}

export interface EditRuntime {
	versionCache?: ReadVersionCache;
}

/** edit 只修改一个已读 UTF-8 文件；所有替换都基于调用开始时的原始内容匹配。 */
export async function editWorkspace(cwd: string, params: unknown, runtime: EditRuntime = {}): Promise<ToolOutcome<EditSuccess>> {
	const prepared = await prepareEdit(cwd, params, "cached", runtime.versionCache);
	if (isFailed(prepared)) return prepared;

	const bytes = buildTextBytes(prepared.updatedText, prepared.file.hasBom);
	try {
		await writeFile(prepared.absolutePath, bytes);
	} catch {
		return fail("ACCESS_DENIED", "File could not be written.", { path: prepared.path });
	}

	runtime.versionCache?.remember(prepared.absolutePath, sha256Version(bytes));
	const diff = buildDiff(prepared.file.text, prepared.updatedText);
	return {
		status: "applied",
		path: prepared.path,
		replacements: prepared.replacements,
		old_version: prepared.file.version,
		new_version: sha256Version(bytes),
		diff: diff.diff,
		...(diff.firstChangedLine !== undefined ? { firstChangedLine: diff.firstChangedLine } : {}),
	};
}

/** 生成只读预览；用于 renderer 展示，不要求 read cache，也不写入文件。 */
export async function previewEditWorkspace(cwd: string, params: unknown): Promise<ToolOutcome<EditPreviewSuccess>> {
	const prepared = await prepareEdit(cwd, params, "current", undefined);
	if (isFailed(prepared)) return prepared;
	const diff = buildDiff(prepared.file.text, prepared.updatedText);
	return {
		status: "preview",
		path: prepared.path,
		replacements: prepared.replacements,
		diff: diff.diff,
		...(diff.firstChangedLine !== undefined ? { firstChangedLine: diff.firstChangedLine } : {}),
	};
}

async function prepareEdit(
	cwd: string,
	params: unknown,
	readPolicy: "cached" | "current",
	versionCache: ReadVersionCache | undefined,
): Promise<ToolOutcome<PreparedEdit>> {
	const input = validateEditInput(params);
	if (isFailed(input)) return input;

	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const resolved = await resolveExistingFile(workspaceRoot, input.path, config);
	if (isFailed(resolved)) return resolved;
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	noteSoftIgnore(ignoreSnapshot, resolved.workspacePath);

	const file = await readExistingWithVersion(resolved.realPath, resolved.relativePath, versionCache?.get(resolved.realPath), readPolicy);
	if (isFailed(file)) return file;

	const updatedText = applyReplacements(file.text, input.edits, resolved.relativePath);
	if (isFailed(updatedText)) return updatedText;
	return {
		path: resolved.relativePath,
		absolutePath: resolved.realPath,
		file,
		updatedText,
		replacements: input.edits.length,
	};
}

function validateEditInput(params: unknown): ToolOutcome<EditParams> {
	if (!isPlainRecord(params)) {
		return fail("INVALID_OPERATION", "edit input must be an object.");
	}
	const allowedTop = new Set(["path", "edits"]);
	for (const key of Object.keys(params)) {
		if (!allowedTop.has(key)) {
			return fail("INVALID_OPERATION", `Unsupported edit field: ${key}.`, { details: { field: key } });
		}
	}
	if (typeof params["path"] !== "string") {
		return fail("INVALID_OPERATION", "path must be a string.");
	}
	const edits = params["edits"];
	if (!Array.isArray(edits) || edits.length === 0) {
		return fail("INVALID_OPERATION", "edits must be a non-empty array.");
	}

	const replacements: EditReplacement[] = [];
	for (let index = 0; index < edits.length; index += 1) {
		const replacement = validateReplacement(edits[index], index);
		if (isFailed(replacement)) return replacement;
		replacements.push(replacement);
	}
	return { path: params["path"], edits: replacements };
}

function validateReplacement(value: unknown, index: number): ToolOutcome<EditReplacement> {
	if (!isPlainRecord(value)) {
		return fail("INVALID_OPERATION", "edit entry must be an object.", { edit_index: index });
	}
	const allowed = new Set(["old", "new"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			return fail("INVALID_OPERATION", `Unsupported edits[${index}] field: ${key}.`, { edit_index: index, details: { field: key } });
		}
	}
	if (typeof value["old"] !== "string") {
		return fail("INVALID_OPERATION", `edits[${index}].old must be a string.`, { edit_index: index });
	}
	if (value["old"].length === 0) {
		return fail("EMPTY_OLD_TEXT", `edits[${index}].old must not be empty.`, { edit_index: index });
	}
	if (typeof value["new"] !== "string") {
		return fail("INVALID_OPERATION", `edits[${index}].new must be a string.`, { edit_index: index });
	}
	return { old: value["old"], new: value["new"] };
}

function noteSoftIgnore(ignoreSnapshot: IgnoreSnapshot, workspacePath: string | undefined): void {
	if (workspacePath === undefined) return;
	ignoreSnapshot.evaluate({ path: workspacePath, kind: "file", intent: "explicit-edit" });
}

async function readExistingWithVersion(
	absolutePath: string,
	relativePath: string,
	expected: string | undefined,
	readPolicy: "cached" | "current",
): Promise<ToolOutcome<TextFile>> {
	if (expected === undefined) {
		if (readPolicy === "cached") {
			return fail("READ_REQUIRED", "Read the file before editing it.", { path: relativePath });
		}
		return readTextFile(absolutePath, relativePath);
	}
	const file = await readTextFile(absolutePath, relativePath);
	if (isFailed(file)) return file;
	if (expected !== file.version) {
		return fail("STALE_READ", "The file changed after it was read. Read the file again before editing.", {
			path: relativePath,
			expected,
			actual: file.version,
		});
	}
	return file;
}

function applyReplacements(text: string, replacements: EditReplacement[], relativePath: string): ToolOutcome<string> {
	const matches: MatchedReplacement[] = [];
	for (let index = 0; index < replacements.length; index += 1) {
		const replacement = replacements[index];
		if (replacement === undefined) continue;
		const starts = findAll(text, replacement.old);
		if (starts.length === 0) {
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file.`, {
				path: relativePath,
				edit_index: index,
			});
		}
		if (starts.length > 1) {
			return fail("OLD_TEXT_NOT_UNIQUE", `edits[${index}].old matched multiple locations.`, {
				path: relativePath,
				edit_index: index,
				details: { matches: starts.length },
			});
		}
		const start = starts[0];
		if (start === undefined) {
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file.`, {
				path: relativePath,
				edit_index: index,
			});
		}
		matches.push({ index, start, end: start + replacement.old.length, replacement });
	}

	matches.sort((a, b) => a.start - b.start);
	for (let index = 1; index < matches.length; index += 1) {
		const previous = matches[index - 1];
		const current = matches[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end) {
			return fail("OVERLAPPING_REPLACEMENTS", `edits[${previous.index}] and edits[${current.index}] overlap.`, {
				path: relativePath,
				edit_index: current.index,
				details: { previous_edit_index: previous.index },
			});
		}
	}

	let output = "";
	let cursor = 0;
	for (const match of matches) {
		output += text.slice(cursor, match.start);
		output += match.replacement.new;
		cursor = match.end;
	}
	output += text.slice(cursor);
	return output;
}

function findAll(text: string, needle: string): number[] {
	const starts: number[] = [];
	let cursor = 0;
	while (cursor <= text.length - needle.length) {
		const found = text.indexOf(needle, cursor);
		if (found === -1) break;
		starts.push(found);
		cursor = found + Math.max(needle.length, 1);
	}
	return starts;
}

function buildDiff(oldText: string, newText: string): { diff: string; firstChangedLine?: number } {
	const result = generateDiffString(normalizeLineEndings(oldText), normalizeLineEndings(newText));
	return {
		diff: result.diff,
		...(result.firstChangedLine !== undefined ? { firstChangedLine: result.firstChangedLine } : {}),
	};
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
