import { languageFromPath, splitTokens, tokenizeText } from "../../code-index/parser.js";
import type { ScannedLine, TextContent } from "../../filesystem/contracts/content.js";
import { scannedTextLines, utf8ByteOffset } from "../../filesystem/services/text.js";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { TextFileEvidence, TextHit } from "./candidates.js";
import type { ScopeInventory, ScopedFile } from "./inventory.js";
import type { QueryPlan } from "./query-plan.js";
import type { GrepScopeError, GrepSkippedFiles } from "./types.js";

const MAX_ANCHORS_PER_FILE = 64;
export const MAX_STORED_TEXT_HITS = 10_000;
export const MAX_STORED_LEXICAL_ANCHORS = 10_000;

export interface TextScanStats {
	readonly searchedFiles: number;
	readonly searchedBytes: number;
	readonly droppedTextHits: number;
	readonly droppedRelatedAnchors: number;
	readonly skipped: GrepSkippedFiles;
}

export interface TextScanResult {
	readonly hits: readonly TextHit[];
	readonly totalHits: number;
	readonly fileEvidence: readonly TextFileEvidence[];
	/** 小型代码文件的稳定正文，供后续 LSP 或 Tree-sitter 直接复用。 */
	readonly contents: ReadonlyMap<string, TextContent>;
	readonly stats: TextScanStats;
	readonly scopeErrors: readonly GrepScopeError[];
}

export interface TextScannerContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxStoredHits?: number;
	readonly maxStoredAnchors?: number;
	readonly retainTextMaxBytes?: number;
}

interface LineMatch {
	readonly start: number;
	readonly end: number;
}

interface MutableLexicalAnchor {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineText: string;
	readonly matchedTerms: readonly string[];
	readonly phrase: boolean;
}

interface FileScanSuccess {
	readonly hits: TextHit[];
	readonly totalHits: number;
	readonly droppedTextHits: number;
	readonly evidence: TextFileEvidence;
	readonly droppedRelatedAnchors: number;
	readonly content?: TextContent;
}

/** 通过 filesystem line scan 产生 regex/literal 事实命中，并同步收集零命中回退所需的有界词法证据。 */
export async function scanInventoryText(
	inventory: ScopeInventory,
	plan: Pick<QueryPlan, "queryMode" | "regex" | "targetTerms" | "targetQuery">,
	context: TextScannerContext,
): Promise<ToolOutcome<TextScanResult>> {
	const maxStoredHits = context.maxStoredHits ?? MAX_STORED_TEXT_HITS;
	const maxStoredAnchors = context.maxStoredAnchors ?? MAX_STORED_LEXICAL_ANCHORS;
	if (!validLimit(maxStoredHits) || !validLimit(maxStoredAnchors)) {
		return fail("INVALID_OPERATION", "Text candidate limits must be non-negative safe integers.");
	}
	const matcher = createLineMatcher(plan);
	const hits: TextHit[] = [];
	const fileEvidence: TextFileEvidence[] = [];
	const contents = new Map<string, TextContent>();
	const scopeErrors: GrepScopeError[] = [];
	const skipped: Required<GrepSkippedFiles> = {
		binary: 0,
		invalid_utf8: 0,
		access_denied: 0,
		too_large: 0,
		changed: 0,
	};
	let searchedFiles = 0;
	let searchedBytes = 0;
	let totalHits = 0;
	let storedAnchors = 0;
	let droppedTextHits = 0;
	let droppedRelatedAnchors = 0;

	for (const file of inventory.files) {
		if (context.operation.signal?.aborted === true) return aborted(file.path);
		const scanned = await scanFile(
			file,
			plan,
			matcher,
			context,
			Math.max(0, maxStoredHits - hits.length),
			Math.max(0, maxStoredAnchors - storedAnchors),
		);
		if (!scanned.ok) {
			if (scanned.error.code === "aborted") return aborted(file.path);
			if (file.explicitFile) scopeErrors.push(scopeError(file, mapFsError(scanned.error, { notFound: "file", path: file.path })));
			else if (!countSkippedFile(skipped, scanned.error)) return mapFsError(scanned.error, { path: file.path });
			continue;
		}
		searchedFiles += 1;
		searchedBytes += file.snapshot.sizeBytes;
		totalHits += scanned.value.totalHits;
		hits.push(...scanned.value.hits);
		fileEvidence.push(scanned.value.evidence);
		if (scanned.value.content !== undefined) contents.set(file.path, scanned.value.content);
		storedAnchors += scanned.value.evidence.anchors.length;
		droppedTextHits += scanned.value.droppedTextHits;
		droppedRelatedAnchors += scanned.value.droppedRelatedAnchors;
	}
	if (totalHits > 0) {
		const retainedPaths = new Set(hits.map((hit) => hit.path));
		for (const evidence of fileEvidence) {
			if (evidence.anchors.length > 0) retainedPaths.add(evidence.path);
		}
		for (const path of contents.keys()) {
			if (!retainedPaths.has(path)) contents.delete(path);
		}
	}

	return {
		hits,
		totalHits,
		fileEvidence,
		contents,
		stats: {
			searchedFiles,
			searchedBytes,
			droppedTextHits,
			droppedRelatedAnchors,
			skipped: compactSkipped(skipped),
		},
		scopeErrors,
	};
}

async function scanFile(
	file: ScopedFile,
	plan: Pick<QueryPlan, "queryMode" | "targetTerms" | "targetQuery">,
	matcher: (line: string) => LineMatch | undefined,
	context: TextScannerContext,
	remainingHitCapacity: number,
	remainingAnchorCapacity: number,
): Promise<{ readonly ok: true; readonly value: FileScanSuccess } | { readonly ok: false; readonly error: FsError }> {
	let retained: TextContent | undefined;
	let lines: AsyncIterable<{ readonly ok: true; readonly value: ScannedLine } | { readonly ok: false; readonly error: FsError }>;
	let close: () => Promise<void>;
	if (
		context.retainTextMaxBytes !== undefined
		&& file.snapshot.sizeBytes <= context.retainTextMaxBytes
		&& languageFromPath(file.path) !== "text"
	) {
		const loaded = await context.filesystem.content.readText(
			file.ref,
			{
				maxBytes: context.retainTextMaxBytes,
				expectedSnapshot: file.snapshot,
				stable: true,
				rejectBinary: true,
			},
			context.operation,
		);
		if (!loaded.ok) return loaded;
		retained = loaded.value;
		lines = successfulLines(scannedTextLines(retained.text));
		close = async () => undefined;
	} else {
		const opened = await context.filesystem.content.scanLines(
			file.ref,
			{ expectedSnapshot: file.snapshot, stable: true, rejectBinary: true },
			context.operation,
		);
		if (!opened.ok) return opened;
		lines = opened.value;
		close = () => opened.value.close();
	}
	const fileHits: TextHit[] = [];
	const anchors: MutableLexicalAnchor[] = [];
	const matchedTerms = new Set<string>();
	const queryTerms = uniqueLowerTerms(plan.targetTerms.flatMap(splitTokens));
	const phrase = plan.targetQuery.trim().toLocaleLowerCase();
	let totalHits = 0;
	let droppedTextHits = 0;
	let droppedRelatedAnchors = 0;
	let failure: FsError | undefined;
	try {
		for await (const result of lines) {
			if (!result.ok) {
				failure = result.error;
				break;
			}
			const line = result.value;
			const match = matcher(line.text);
			if (match !== undefined) {
				totalHits += 1;
				if (fileHits.length < remainingHitCapacity) {
					const hit = createTextHit(file.path, line, match, plan.queryMode);
					if (hit !== undefined) fileHits.push(hit);
				} else droppedTextHits += 1;
			}
			const lineTokens = tokenizeText(line.text);
			const lineTerms = queryTerms.filter((term) => lineTokens.has(term));
			for (const term of lineTerms) matchedTerms.add(term);
			const lineLower = line.text.toLocaleLowerCase();
			const hasPhrase = phrase.length > 0 && lineLower.includes(phrase);
			if (lineTerms.length > 0 || hasPhrase) {
				if (anchors.length < MAX_ANCHORS_PER_FILE && anchors.length < remainingAnchorCapacity) {
					anchors.push(createLexicalAnchor(file.path, line, lineTerms, hasPhrase));
				} else droppedRelatedAnchors += 1;
			}
		}
	} finally {
		await close();
	}
	if (failure !== undefined) return { ok: false, error: failure };
	return {
		ok: true,
		value: {
			hits: fileHits,
			totalHits,
			droppedTextHits,
			droppedRelatedAnchors,
			evidence: {
				path: file.path,
				matchedTerms: queryTerms.filter((term) => matchedTerms.has(term)),
				anchors,
			},
			...(retained === undefined ? {} : { content: retained }),
		},
	};
}

async function* successfulLines(
	lines: readonly ScannedLine[],
): AsyncGenerator<{ readonly ok: true; readonly value: ScannedLine }> {
	for (const line of lines) yield { ok: true, value: line };
}

function createLineMatcher(
	plan: Pick<QueryPlan, "regex">,
): (line: string) => LineMatch | undefined {
	const source = plan.regex.source;
	const flags = plan.regex.flags.replaceAll("g", "").replaceAll("y", "");
	const expression = new RegExp(source, flags);
	return (line) => {
		const match = expression.exec(line);
		if (match === null) return undefined;
		return { start: match.index, end: match.index + match[0].length };
	};
}

function createTextHit(
	path: string,
	line: ScannedLine,
	match: LineMatch,
	queryMode: QueryPlan["queryMode"],
): TextHit | undefined {
	const startByte = utf8ByteOffset(line.text, match.start);
	const endByte = utf8ByteOffset(line.text, match.end);
	if (startByte === undefined || endByte === undefined) return undefined;
	return {
		path,
		line: line.line,
		byteStart: line.byteStart + startByte,
		byteEnd: line.byteStart + endByte,
		matchStart: match.start,
		matchEnd: match.end,
		matchMode: queryMode === "literal_fallback" ? "literal" : "regex",
		lineText: line.text,
	};
}

function createLexicalAnchor(
	path: string,
	line: ScannedLine,
	matchedTerms: readonly string[],
	phrase: boolean,
): MutableLexicalAnchor {
	return {
		path,
		line: line.line,
		byteStart: line.byteStart,
		byteEnd: line.byteEnd,
		lineText: line.text,
		matchedTerms: [...matchedTerms],
		phrase,
	};
}

function uniqueLowerTerms(terms: readonly string[]): string[] {
	return [...new Set(terms.map((term) => term.toLocaleLowerCase()).filter((term) => term.length > 0))];
}

function countSkippedFile(skipped: Required<GrepSkippedFiles>, error: FsError): boolean {
	switch (error.code) {
		case "binary": skipped.binary += 1; return true;
		case "invalid-utf8": skipped.invalid_utf8 += 1; return true;
		case "access-denied": skipped.access_denied += 1; return true;
		case "too-large": skipped.too_large += 1; return true;
		case "changed-during-read":
		case "not-found":
		case "not-file": skipped.changed += 1; return true;
		default: return false;
	}
}

function compactSkipped(skipped: Required<GrepSkippedFiles>): GrepSkippedFiles {
	const result: GrepSkippedFiles = {};
	if (skipped.binary > 0) result.binary = skipped.binary;
	if (skipped.invalid_utf8 > 0) result.invalid_utf8 = skipped.invalid_utf8;
	if (skipped.access_denied > 0) result.access_denied = skipped.access_denied;
	if (skipped.too_large > 0) result.too_large = skipped.too_large;
	if (skipped.changed > 0) result.changed = skipped.changed;
	return result;
}

function scopeError(file: ScopedFile, failure: ReturnType<typeof fail>): GrepScopeError {
	return { path: file.scopeInput, error: failure.error };
}

function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function aborted(path: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "Operation aborted.", { path });
}
