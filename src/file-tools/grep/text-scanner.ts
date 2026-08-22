import { availableParallelism } from "node:os";

import { createTextTokenMatcher, languageFromPath, splitTokens } from "../../code-index/parser.js";
import type { ScannedLine, TextContent } from "../../filesystem/contracts/content.js";
import { scannedTextLines, utf8ByteOffset } from "../../filesystem/services/text.js";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import type { TextFileEvidence, TextHit } from "./candidates.js";
import type { GrepContentCacheLease } from "./content-cache.js";
import type { ScopeInventory, ScopedFile } from "./inventory.js";
import type { QueryPlan } from "./query-plan.js";
import { compactGrepSkippedFiles, createGrepSkippedFiles, recordSkippedFile } from "./skipped.js";
import type { GrepScopeError, GrepSkippedFiles } from "./types.js";

const MAX_ANCHORS_PER_FILE = 64;
const DEFAULT_FILE_SCAN_CONCURRENCY = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
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
	/** 仅供 runtime 调优与边界测试；不暴露为模型参数。 */
	readonly fileConcurrency?: number;
	readonly retainTextMaxBytes?: number;
	readonly contentCache?: GrepContentCacheLease;
}

interface LineMatch {
	readonly start: number;
	readonly end: number;
}

interface PreparedTextQuery {
	readonly queryMode: QueryPlan["queryMode"];
	readonly matcher: (line: string) => LineMatch | undefined;
	readonly queryTerms: readonly string[];
	readonly matchTerms: (line: string) => readonly string[];
	readonly phrase: string;
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
	readonly evidence: TextFileEvidence;
	readonly totalAnchors: number;
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
	const fileConcurrency = context.fileConcurrency ?? DEFAULT_FILE_SCAN_CONCURRENCY;
	const query = prepareTextQuery(plan);
	const hits: TextHit[] = [];
	const fileEvidence: TextFileEvidence[] = [];
	const contents = new Map<string, TextContent>();
	const scopeErrors: GrepScopeError[] = [];
	const skipped = createGrepSkippedFiles();
	let searchedFiles = 0;
	let searchedBytes = 0;
	let totalHits = 0;
	let storedAnchors = 0;
	let droppedTextHits = 0;
	let droppedRelatedAnchors = 0;

	for (let start = 0; start < inventory.files.length; start += fileConcurrency) {
		if (context.operation.signal?.aborted === true) return aborted(inventory.files[start]?.path ?? inventory.scopes[0]?.input ?? ".");
		const batch = inventory.files.slice(start, start + fileConcurrency);
		const scannedBatch = await Promise.all(batch.map(async (file) => await scanFile(
			file,
			query,
			context,
			maxStoredHits,
			maxStoredAnchors,
		)));
		for (const [index, scanned] of scannedBatch.entries()) {
			const file = batch[index];
			if (file === undefined) continue;
			if (!scanned.ok) {
				if (scanned.error.code === "aborted") return aborted(file.path);
				if (file.explicitFile) scopeErrors.push(scopeError(file, mapFsError(scanned.error, { notFound: "file", path: file.path })));
				else if (!recordSkippedFile(skipped, scanned.error)) return mapFsError(scanned.error, { path: file.path });
				continue;
			}
			searchedFiles += 1;
			searchedBytes += file.snapshot.sizeBytes;
			totalHits += scanned.value.totalHits;
			const retainedHits = scanned.value.hits.slice(0, Math.max(0, maxStoredHits - hits.length));
			hits.push(...retainedHits);
			droppedTextHits += scanned.value.totalHits - retainedHits.length;
			const retainedAnchors = scanned.value.evidence.anchors.slice(0, Math.max(0, maxStoredAnchors - storedAnchors));
			fileEvidence.push({ ...scanned.value.evidence, anchors: retainedAnchors });
			storedAnchors += retainedAnchors.length;
			droppedRelatedAnchors += scanned.value.totalAnchors - retainedAnchors.length;
			if (scanned.value.content !== undefined) contents.set(file.path, scanned.value.content);
		}
	}
	if (totalHits > 0) {
		const retainedPaths = new Set(hits.map((hit) => hit.path));
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
			skipped: compactGrepSkippedFiles(skipped),
		},
		scopeErrors,
	};
}

async function scanFile(
	file: ScopedFile,
	query: PreparedTextQuery,
	context: TextScannerContext,
	hitCapacity: number,
	anchorCapacity: number,
): Promise<{ readonly ok: true; readonly value: FileScanSuccess } | { readonly ok: false; readonly error: FsError }> {
	let retained: TextContent | undefined;
	const retainText =
		context.retainTextMaxBytes !== undefined
		&& file.snapshot.sizeBytes <= context.retainTextMaxBytes
		&& languageFromPath(file.path) !== "text";
	if (retainText) {
		retained = await context.contentCache?.get(file, context.filesystem, context.operation);
	}
	if (retainText && retained === undefined) {
		const loaded = await context.filesystem.content.readText(
			file.ref,
			{
				maxBytes: context.retainTextMaxBytes,
				expectedSnapshot: file.snapshot,
			},
		);
		if (!loaded.ok) return loaded;
		retained = loaded.value;
		context.contentCache?.set(file, context.filesystem, retained);
	}
	const fileHits: TextHit[] = [];
	const anchors: MutableLexicalAnchor[] = [];
	const matchedTerms = new Set<string>();
	let totalHits = 0;
	let totalAnchors = 0;
	const consumeLine = (line: ScannedLine): void => {
		const match = query.matcher(line.text);
		if (match !== undefined) {
			totalHits += 1;
			if (fileHits.length < hitCapacity) {
				const hit = createTextHit(file.path, line, match, query.queryMode);
				if (hit !== undefined) fileHits.push(hit);
			}
		}
		const lineTerms = query.matchTerms(line.text);
		for (const term of lineTerms) matchedTerms.add(term);
		const hasPhrase = query.phrase.length > 0
			&& line.text.toLocaleLowerCase().includes(query.phrase);
		if (lineTerms.length > 0 || hasPhrase) {
			totalAnchors += 1;
			if (anchors.length < MAX_ANCHORS_PER_FILE && anchors.length < anchorCapacity) {
				anchors.push(createLexicalAnchor(file.path, line, lineTerms, hasPhrase));
			}
		}
	};
	if (retained !== undefined) {
		for (const line of scannedTextLines(retained.text)) consumeLine(line);
	} else {
		const opened = await context.filesystem.content.scanLines(
			file.ref,
			{ expectedSnapshot: file.snapshot },
		);
		if (!opened.ok) return opened;
		let failure: FsError | undefined;
		try {
			for await (const result of opened.value) {
				if (!result.ok) {
					failure = result.error;
					break;
				}
				consumeLine(result.value);
			}
		} finally {
			await opened.value.close();
		}
		if (failure !== undefined) return { ok: false, error: failure };
	}
	return {
		ok: true,
		value: {
			hits: fileHits,
			totalHits,
			totalAnchors,
			evidence: {
				path: file.path,
				matchedTerms: query.queryTerms.filter((term) => matchedTerms.has(term)),
				anchors,
			},
			...(retained === undefined ? {} : { content: retained }),
		},
	};
}

function prepareTextQuery(
	plan: Pick<QueryPlan, "queryMode" | "regex" | "targetTerms" | "targetQuery">,
): PreparedTextQuery {
	const queryTerms = uniqueLowerTerms(plan.targetTerms.flatMap(splitTokens));
	return {
		queryMode: plan.queryMode,
		matcher: createLineMatcher(plan.regex),
		queryTerms,
		matchTerms: createTextTokenMatcher(queryTerms),
		phrase: plan.targetQuery.trim().toLocaleLowerCase(),
	};
}

function createLineMatcher(
	regex: RegExp,
): (line: string) => LineMatch | undefined {
	const source = regex.source;
	const flags = regex.flags.replaceAll("g", "").replaceAll("y", "");
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

function scopeError(file: ScopedFile, failure: ReturnType<typeof fail>): GrepScopeError {
	return { path: file.scopeInput, error: failure.error };
}


function aborted(path: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "Operation aborted.", { path });
}
