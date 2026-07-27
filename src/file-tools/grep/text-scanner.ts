import { tokenizeText } from "../../code-index/parser.js";
import type { ScannedLine } from "../../filesystem/contracts/content.js";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { TextFileEvidence, TextHit } from "./candidates.js";
import type { ScopeInventory, ScopedFile } from "./inventory.js";
import type { QueryPlan } from "./query-plan.js";
import type { GrepScopeError, GrepSkippedFiles, TruncationReason } from "./types.js";

const CONTEXT_LINES = 2;
const MAX_ANCHORS_PER_FILE = 64;
export const MAX_STORED_TEXT_HITS = 10_000;
export const MAX_STORED_LEXICAL_ANCHORS = 10_000;
const UTF8 = new TextEncoder();

export interface TextScanStats {
	readonly searchedFiles: number;
	readonly searchedBytes: number;
	readonly skipped: GrepSkippedFiles;
}

export interface TextScanResult {
	readonly hits: readonly TextHit[];
	readonly totalHits: number;
	readonly fileEvidence: readonly TextFileEvidence[];
	readonly stats: TextScanStats;
	readonly scopeErrors: readonly GrepScopeError[];
	readonly truncationReasons: readonly TruncationReason[];
}

export interface TextScannerContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxTextBytesScanned: number;
	readonly maxTextFileBytes: number;
	readonly maxStoredHits?: number;
	readonly maxStoredAnchors?: number;
}

interface LineMatch {
	readonly start: number;
	readonly end: number;
}

interface PendingContext {
	readonly value: { readonly after: string[] };
	readonly line: number;
}

interface MutableLexicalAnchor {
	readonly path: string;
	readonly line: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineText: string;
	readonly before: readonly string[];
	readonly after: string[];
	readonly matchedTerms: readonly string[];
	readonly phrase: boolean;
	readonly identifier: boolean;
	readonly commentLike: boolean;
	readonly stringLike: boolean;
}

interface FileScanSuccess {
	readonly hits: TextHit[];
	readonly totalHits: number;
	readonly hitLimitReached: boolean;
	readonly evidence: TextFileEvidence;
	readonly anchorLimitReached: boolean;
}

/** 仅通过 filesystem line scan 产生事实命中，并在 auto 中同步收集有界词法证据。 */
export async function scanInventoryText(
	inventory: ScopeInventory,
	plan: Pick<QueryPlan, "query" | "match" | "regex" | "shape" | "targetTerms" | "targetQuery">,
	context: TextScannerContext,
): Promise<ToolOutcome<TextScanResult>> {
	if (!validLimit(context.maxTextBytesScanned) || !validLimit(context.maxTextFileBytes)) {
		return fail("INVALID_OPERATION", "Text scan byte limits must be non-negative safe integers.");
	}
	const maxStoredHits = context.maxStoredHits ?? MAX_STORED_TEXT_HITS;
	const maxStoredAnchors = context.maxStoredAnchors ?? MAX_STORED_LEXICAL_ANCHORS;
	if (!validLimit(maxStoredHits) || !validLimit(maxStoredAnchors)) {
		return fail("INVALID_OPERATION", "Text candidate limits must be non-negative safe integers.");
	}
	const matcher = createLineMatcher(plan);
	const hits: TextHit[] = [];
	const fileEvidence: TextFileEvidence[] = [];
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
	let reservedBytes = 0;
	let totalHits = 0;
	let textByteLimited = false;
	let candidateLimited = false;
	let storedAnchors = 0;

	for (const file of inventory.files) {
		if (context.operation.signal?.aborted === true) return aborted(file.path);
		if (file.size > context.maxTextFileBytes) {
			if (file.explicitFile) scopeErrors.push(scopeError(file, tooLargeFailure(file, context.maxTextFileBytes)));
			else skipped.too_large += 1;
			continue;
		}
		if (file.size > context.maxTextBytesScanned - reservedBytes) {
			textByteLimited = true;
			break;
		}
		reservedBytes += file.size;
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
		searchedBytes += file.size;
		totalHits += scanned.value.totalHits;
		hits.push(...scanned.value.hits);
		fileEvidence.push(scanned.value.evidence);
		storedAnchors += scanned.value.evidence.anchors.length;
		candidateLimited ||= scanned.value.hitLimitReached || scanned.value.anchorLimitReached;
	}

	return {
		hits,
		totalHits,
		fileEvidence,
		stats: {
			searchedFiles,
			searchedBytes,
			skipped: compactSkipped(skipped),
		},
		scopeErrors,
		truncationReasons: [
			...(textByteLimited ? ["text_byte_limit" as const] : []),
			...(candidateLimited ? ["semantic_candidate_limit" as const] : []),
		],
	};
}

async function scanFile(
	file: ScopedFile,
	plan: Pick<QueryPlan, "query" | "match" | "shape" | "targetTerms" | "targetQuery">,
	matcher: (line: string) => LineMatch | undefined,
	context: TextScannerContext,
	remainingHitCapacity: number,
	remainingAnchorCapacity: number,
): Promise<{ readonly ok: true; readonly value: FileScanSuccess } | { readonly ok: false; readonly error: FsError }> {
	const opened = await context.filesystem.content.scanLines(
		file.ref,
		{ maxBytes: context.maxTextFileBytes, stable: true, rejectBinary: true },
		context.operation,
	);
	if (!opened.ok) return opened;
	const before: string[] = [];
	const pending: PendingContext[] = [];
	const fileHits: TextHit[] = [];
	const anchors: MutableLexicalAnchor[] = [];
	const matchedTerms = new Set<string>();
	const phraseLines: number[] = [];
	const identifierLines: number[] = [];
	const queryTerms = uniqueLowerTerms(plan.targetTerms);
	const phrase = plan.targetQuery.trim().toLocaleLowerCase();
	const identifier = plan.shape === "identifier" || plan.shape === "qualified_symbol" ? phrase : "";
	let totalHits = 0;
	let hitLimitReached = false;
	let anchorLimitReached = false;
	let failure: FsError | undefined;
	try {
		for await (const result of opened.value) {
			if (!result.ok) {
				failure = result.error;
				break;
			}
			const line = result.value;
			appendAfterContext(pending, line);
			const match = matcher(line.text);
			if (match !== undefined) {
				totalHits += 1;
				if (fileHits.length < remainingHitCapacity) {
					const hit = createTextHit(file.path, line, match, plan.match === "regex" ? "regex" : "literal", before);
					fileHits.push(hit);
					pending.push({ value: hit, line: hit.line });
				} else hitLimitReached = true;
			}
			if (plan.match === "auto") {
				const lineTokens = tokenizeText(line.text);
				const lineTerms = queryTerms.filter((term) => lineTokens.has(term));
				for (const term of lineTerms) matchedTerms.add(term);
				const lineLower = line.text.toLocaleLowerCase();
				const hasPhrase = phrase.length > 0 && lineLower.includes(phrase);
				const hasIdentifier = identifier.length > 0 && lineLower.includes(identifier);
				if (hasPhrase && phraseLines.length < MAX_ANCHORS_PER_FILE) phraseLines.push(line.line);
				else if (hasPhrase) anchorLimitReached = true;
				if (hasIdentifier && identifierLines.length < MAX_ANCHORS_PER_FILE) identifierLines.push(line.line);
				else if (hasIdentifier) anchorLimitReached = true;
				if (lineTerms.length > 0 || hasPhrase || hasIdentifier) {
					if (anchors.length < MAX_ANCHORS_PER_FILE && anchors.length < remainingAnchorCapacity) {
						const anchor = createLexicalAnchor(file.path, line, before, lineTerms, hasPhrase, hasIdentifier);
						anchors.push(anchor);
						pending.push({ value: anchor, line: anchor.line });
					} else anchorLimitReached = true;
				}
			}
			before.push(line.text);
			if (before.length > CONTEXT_LINES) before.shift();
		}
	} finally {
		await opened.value.close();
	}
	if (failure !== undefined) return { ok: false, error: failure };
	const pathTokenMap = tokenizeText(file.path);
	return {
		ok: true,
		value: {
			hits: fileHits,
			totalHits,
			hitLimitReached,
			anchorLimitReached,
			evidence: {
				path: file.path,
				matchedTerms: queryTerms.filter((term) => matchedTerms.has(term)),
				pathTerms: queryTerms.filter((term) => pathTokenMap.has(term)),
				phraseLines,
				identifierLines,
				anchors,
			},
		},
	};
}

function createLineMatcher(
	plan: Pick<QueryPlan, "query" | "match" | "regex">,
): (line: string) => LineMatch | undefined {
	if (plan.match === "literal" || plan.match === "auto") {
		return (line) => {
			const start = line.indexOf(plan.query);
			return start < 0 ? undefined : { start, end: start + plan.query.length };
		};
	}
	const source = plan.regex?.source ?? plan.query;
	const flags = plan.regex?.flags.replaceAll("g", "").replaceAll("y", "") ?? "u";
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
	mode: "literal" | "regex",
	before: readonly string[],
): TextHit & { readonly after: string[] } {
	return {
		path,
		line: line.line,
		byteStart: line.byteStart + utf8Length(line.text.slice(0, match.start)),
		byteEnd: line.byteStart + utf8Length(line.text.slice(0, match.end)),
		mode,
		lineText: line.text,
		before: [...before],
		after: [],
	};
}

function createLexicalAnchor(
	path: string,
	line: ScannedLine,
	before: readonly string[],
	matchedTerms: readonly string[],
	phrase: boolean,
	identifier: boolean,
): MutableLexicalAnchor {
	const trimmed = line.text.trimStart();
	return {
		path,
		line: line.line,
		byteStart: line.byteStart,
		byteEnd: line.byteStart + utf8Length(line.text),
		lineText: line.text,
		before: [...before],
		after: [],
		matchedTerms: [...matchedTerms],
		phrase,
		identifier,
		commentLike: /^(?:\/\/|\/\*|\*|#|--)/u.test(trimmed),
		stringLike: /["'`]/u.test(line.text),
	};
}

function appendAfterContext(pending: PendingContext[], line: ScannedLine): void {
	for (const candidate of pending) {
		if (line.line > candidate.line && candidate.value.after.length < CONTEXT_LINES) candidate.value.after.push(line.text);
	}
	while (pending[0]?.value.after.length === CONTEXT_LINES) pending.shift();
}

function uniqueLowerTerms(terms: readonly string[]): string[] {
	return [...new Set(terms.map((term) => term.toLocaleLowerCase()).filter((term) => term.length > 0))];
}

function utf8Length(value: string): number {
	return UTF8.encode(value).byteLength;
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

function tooLargeFailure(file: ScopedFile, limit: number): ReturnType<typeof fail> {
	return fail("OUTPUT_LIMIT_EXCEEDED", "File is too large to search.", {
		path: file.path,
		details: { limit, size: file.size },
	});
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
