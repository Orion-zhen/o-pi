import { languageFromPath, type AnalyzedFileIndex, type IndexedCodeUnit } from "../../code-index/parser.js";
import type { TextContent } from "../../filesystem/contracts/content.js";
import type { FileMetadata } from "../../filesystem/contracts/metadata.js";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import { createVerifiedCodeRegion, type RegionEvidence, type TextHit, type VerifiedCodeRegion } from "./candidates.js";
import type { ScopeInventory, ScopedFile } from "./inventory.js";
import { AbortGrepParse, GrepParser } from "./parser-pool.js";
import type { GrepScopeError, GrepSkippedFiles, TruncationReason } from "./types.js";

const AST_CACHE_MAX_ENTRIES = 2_048;
const UTF8_BOM_BYTES = 3;

interface CachedAst {
	readonly filesystemIdentity: string;
	readonly visibilityFingerprint: string;
	readonly canonicalIdentity: string;
	readonly path: string;
	readonly metadataVersion: string;
	readonly contentHash: string;
	readonly analysis: AnalyzedFileIndex;
}

interface PreparedFile {
	readonly file: ScopedFile;
	readonly content: TextContent;
	readonly hits: readonly [TextHit, ...TextHit[]];
	readonly filesystemIdentity: string;
	readonly visibilityFingerprint: string;
	readonly cacheKey: string;
	readonly cached?: CachedAst;
}

interface HitFile {
	readonly file: ScopedFile;
	readonly hits: readonly [TextHit, ...TextHit[]];
}

export interface RegionizationResult {
	readonly regions: readonly VerifiedCodeRegion[];
	readonly parsedFiles: number;
	readonly skipped: GrepSkippedFiles;
	readonly scopeErrors: readonly GrepScopeError[];
	readonly truncationReasons: readonly TruncationReason[];
}

export interface RegionizerContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly maxFilesParsed: number;
	readonly maxParseFileBytes: number;
}

/** 将流式事实命中映射到当前正文的最小代码区域；缓存只保存派生 AST。 */
export class GrepRegionizer {
	private readonly cache = new Map<string, CachedAst>();
	private disposed = false;

	constructor(private readonly parser: GrepParser) {}

	async regionize(
		inventory: ScopeInventory,
		hits: readonly TextHit[],
		context: RegionizerContext,
	): Promise<ToolOutcome<RegionizationResult>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		if (!validLimit(context.maxFilesParsed) || !validLimit(context.maxParseFileBytes)) {
			return fail("INVALID_OPERATION", "Parse limits must be non-negative safe integers.");
		}
		const files = hitFiles(inventory, hits);
		const rankByHit = new Map(hits.map((hit, index) => [hit, index + 1]));
		const fallback = new Map<string, readonly [TextHit, ...TextHit[]]>();
		const prepared: PreparedFile[] = [];
		const scopeErrors: GrepScopeError[] = [];
		const skipped: Required<GrepSkippedFiles> = {
			binary: 0,
			invalid_utf8: 0,
			access_denied: 0,
			too_large: 0,
			changed: 0,
		};
		let semanticLimited = false;
		let parseCandidates = 0;
		let parsedFiles = 0;

		for (const candidate of files) {
			if (isAborted(context.operation.signal)) return aborted(candidate.file.path);
			if (languageFromPath(candidate.file.path) === "text") {
				fallback.set(candidate.file.path, candidate.hits);
				continue;
			}
			if (candidate.file.size > context.maxParseFileBytes || parseCandidates >= context.maxFilesParsed) {
				semanticLimited = true;
				fallback.set(candidate.file.path, candidate.hits);
				continue;
			}
			parseCandidates += 1;
			const loaded = await this.prepare(candidate, context);
			if (!loaded.ok) {
				if (loaded.error.code === "aborted") return aborted(candidate.file.path);
				if (candidate.file.explicitFile) scopeErrors.push({
					path: candidate.file.scopeInput,
					error: mapFsError(loaded.error, { notFound: "file", path: candidate.file.path }).error,
				});
				else countSkipped(skipped, loaded.error);
				continue;
			}
			if (loaded.value === undefined) {
				if (candidate.file.explicitFile) scopeErrors.push({
					path: candidate.file.scopeInput,
					error: fail("STALE_READ", "File changed after text scanning.", { path: candidate.file.path }).error,
				});
				else skipped.changed += 1;
				continue;
			}
			if (hasBareCr(loaded.value.content.text)) {
				fallback.set(candidate.file.path, candidate.hits);
				continue;
			}
			prepared.push(loaded.value);
		}

		const analyses = await this.analyzePrepared(prepared, context.operation.signal);
		if (analyses.status === "failed") return analyses;
		const regions: Array<{ readonly order: number; readonly region: VerifiedCodeRegion }> = [];
		for (const [index, file] of prepared.entries()) {
			const analysis = analyses.values[index];
			if (analysis === undefined || analysis.status !== "parsed") {
				fallback.set(file.file.path, file.hits);
				continue;
			}
			parsedFiles += 1;
			const parsed = parsedRegions(file, analysis.index.units, rankByHit);
			for (const region of parsed) {
				regions.push({ order: rankByHit.get(region.verifiedHits[0]) ?? Number.MAX_SAFE_INTEGER, region });
			}
			const mappedHits = new Set(parsed.flatMap((region) => region.verifiedHits));
			const outside = file.hits.filter((hit) => !mappedHits.has(hit));
			if (outside.length > 0) fallback.set(file.file.path, asNonEmpty(outside));
		}
		for (const fileHits of fallback.values()) {
			for (const region of textRegions(fileHits, rankByHit)) {
				regions.push({ order: rankByHit.get(region.verifiedHits[0]) ?? Number.MAX_SAFE_INTEGER, region });
			}
		}
		regions.sort((left, right) => left.order - right.order || compareRegion(left.region, right.region));
		return {
			regions: regions.map((item) => item.region),
			parsedFiles,
			skipped: compactSkipped(skipped),
			scopeErrors,
			truncationReasons: semanticLimited ? ["semantic_candidate_limit"] : [],
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cache.clear();
	}

	private async prepare(
		candidate: HitFile,
		context: RegionizerContext,
	): Promise<{ readonly ok: true; readonly value: PreparedFile | undefined } | { readonly ok: false; readonly error: FsError }> {
		const metadata = await context.filesystem.metadata.stat(candidate.file.ref, context.operation);
		if (!metadata.ok) return metadata;
		if (metadataVersion(metadata.value) !== candidate.file.metadataVersion) return { ok: true, value: undefined };
		const loaded = await context.filesystem.content.readText(candidate.file.ref, {
			maxBytes: context.maxParseFileBytes,
			stable: true,
			rejectBinary: true,
		}, context.operation);
		if (!loaded.ok) return loaded;
		if (!allHitsCurrent(candidate.hits, loaded.value, context.filesystem)) return { ok: true, value: undefined };
		const cacheKey = astCacheKey(candidate.file, loaded.value.hash, context.filesystem);
		const cached = this.cacheGet(cacheKey);
		return {
			ok: true,
			value: {
				file: candidate.file,
				content: loaded.value,
				hits: candidate.hits,
				filesystemIdentity: context.filesystem.identity,
				visibilityFingerprint: context.filesystem.visibility.snapshot.fingerprint,
				cacheKey,
				...(cached === undefined ? {} : { cached }),
			},
		};
	}

	private async analyzePrepared(
		files: readonly PreparedFile[],
		signal: AbortSignal | undefined,
	): Promise<{ readonly status: "success"; readonly values: readonly AnalyzedFileIndex[] } | ReturnType<typeof fail>> {
		const pending = files.filter((file) => file.cached === undefined);
		let fresh: readonly AnalyzedFileIndex[];
		try {
			fresh = await this.parser.analyzeFiles(pending.map((file) => ({
				path: file.file.path,
				text: file.content.text,
				syntax: true,
			})), signal);
		} catch (error) {
			if (signal?.aborted === true || error instanceof AbortGrepParse) return aborted();
			fresh = [];
		}
		let freshIndex = 0;
		const values: AnalyzedFileIndex[] = [];
		for (const file of files) {
			let analysis = file.cached?.analysis;
			if (analysis === undefined) {
				analysis = fresh[freshIndex];
				freshIndex += 1;
				if (analysis !== undefined) this.cacheSet(file.cacheKey, {
					filesystemIdentity: file.filesystemIdentity,
					visibilityFingerprint: file.visibilityFingerprint,
					canonicalIdentity: file.file.canonicalIdentity,
					path: file.file.path,
					metadataVersion: file.file.metadataVersion,
					contentHash: file.content.hash,
					analysis,
				});
			}
			if (analysis === undefined) {
				analysis = {
					index: { id: file.file.canonicalIdentity, path: file.file.path, language: languageFromPath(file.file.path), units: [], symbols: [] },
					status: "error",
					imports: [],
				};
			}
			values.push(analysis);
		}
		return { status: "success", values };
	}

	private cacheGet(key: string): CachedAst | undefined {
		const cached = this.cache.get(key);
		if (cached === undefined) return undefined;
		this.cache.delete(key);
		this.cache.set(key, cached);
		return cached;
	}

	private cacheSet(key: string, value: CachedAst): void {
		this.cache.delete(key);
		this.cache.set(key, value);
		while (this.cache.size > AST_CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}
}

function hitFiles(inventory: ScopeInventory, hits: readonly TextHit[]): HitFile[] {
	const hitsByPath = new Map<string, TextHit[]>();
	for (const hit of hits) {
		const grouped = hitsByPath.get(hit.path);
		if (grouped === undefined) hitsByPath.set(hit.path, [hit]);
		else grouped.push(hit);
	}
	const result: HitFile[] = [];
	for (const file of inventory.files) {
		const grouped = hitsByPath.get(file.path);
		if (grouped === undefined || grouped.length === 0) continue;
		result.push({ file, hits: asNonEmpty(grouped) });
	}
	return result;
}

function parsedRegions(
	file: PreparedFile,
	units: readonly IndexedCodeUnit[],
	rankByHit: ReadonlyMap<TextHit, number>,
): VerifiedCodeRegion[] {
	const grouped = new Map<string, { readonly unit: IndexedCodeUnit; readonly hits: TextHit[] }>();
	for (const hit of file.hits) {
		const offset = file.content.hasBom ? UTF8_BOM_BYTES : 0;
		const startByte = Math.max(0, hit.byteStart - offset);
		const endByte = Math.max(startByte, hit.byteEnd - offset);
		const unit = units
			.filter((candidate) => candidate.startByte <= startByte && endByte <= candidate.endByte)
			.sort((left, right) => (left.endByte - left.startByte) - (right.endByte - right.startByte)
				|| left.startByte - right.startByte || compareStableString(left.id, right.id))[0];
		if (unit === undefined) continue;
		const existing = grouped.get(unit.id);
		if (existing === undefined) grouped.set(unit.id, { unit, hits: [hit] });
		else existing.hits.push(hit);
	}
	return [...grouped.values()].map(({ unit, hits }) => {
		const sortedHits = [...hits].sort((left, right) => left.line - right.line || left.byteStart - right.byteStart);
		const first = sortedHits[0];
		if (first === undefined) throw new RangeError("parsed region requires a hit");
		return createVerifiedCodeRegion({
			id: unit.id,
			path: file.file.path,
			startLine: unit.startLine,
			endLine: unit.endLine,
			startByte: unit.startByte,
			endByte: unit.endByte,
			kind: unit.kind,
			...(unit.name === undefined ? {} : { symbol: unit.qualifiedName ?? unit.name }),
			...(unit.qualifiedName === undefined ? {} : { qualifiedSymbol: unit.qualifiedName }),
			...(unit.signature === undefined ? {} : { signature: unit.signature }),
			roles: ["occurrence"],
			signals: ["verified_enclosing_region"],
			evidence: [textEvidence(first, rankByHit)],
		}, asNonEmpty(sortedHits));
	});
}

function textRegions(
	hits: readonly [TextHit, ...TextHit[]],
	rankByHit: ReadonlyMap<TextHit, number>,
): VerifiedCodeRegion[] {
	return hits.map((hit) => createVerifiedCodeRegion({
		id: `${hit.path}:${hit.line}:${hit.byteStart}:${hit.byteEnd}`,
		path: hit.path,
		startLine: Math.max(1, hit.line - hit.before.length),
		endLine: hit.line + hit.after.length,
		startByte: hit.byteStart,
		endByte: hit.byteEnd,
		kind: "text",
		roles: ["text"],
		signals: ["verified_text_window"],
		evidence: [textEvidence(hit, rankByHit)],
	}, [hit]));
}

function textEvidence(hit: TextHit, rankByHit: ReadonlyMap<TextHit, number>): RegionEvidence {
	return {
		source: hit.mode === "literal" ? "text-literal" : "text-regex",
		rank: rankByHit.get(hit) ?? Number.MAX_SAFE_INTEGER,
		confidence: 1,
		reason: hit.mode === "literal" ? "exact literal" : "regex",
	};
}

function allHitsCurrent(
	hits: readonly TextHit[],
	content: TextContent,
	filesystem: WorkspaceFileSystem,
): boolean {
	for (const hit of hits) {
		const sliced = filesystem.content.sliceText(content, {
			startLine: hit.line,
			endLine: hit.line,
			maxBytes: Math.max(1, content.sizeBytes),
			maxLines: 1,
			path: hit.path,
		});
		if (!sliced.ok || stripLineTerminator(sliced.value.content) !== hit.lineText) return false;
	}
	return true;
}

function astCacheKey(file: ScopedFile, hash: string, filesystem: WorkspaceFileSystem): string {
	return [
		filesystem.identity,
		filesystem.visibility.snapshot.fingerprint,
		file.canonicalIdentity,
		file.path,
		file.metadataVersion,
		hash,
	].join("\0");
}

function metadataVersion(metadata: FileMetadata): string {
	return metadata.version ?? `${metadata.sizeBytes}:${metadata.modifiedAtMs}`;
}

function stripLineTerminator(value: string): string {
	return value.replace(/(?:\r\n|[\r\n])$/u, "");
}

function hasBareCr(text: string): boolean {
	return /\r(?!\n)/u.test(text);
}

function countSkipped(skipped: Required<GrepSkippedFiles>, error: FsError): void {
	switch (error.code) {
		case "binary": skipped.binary += 1; break;
		case "invalid-utf8": skipped.invalid_utf8 += 1; break;
		case "access-denied": skipped.access_denied += 1; break;
		case "too-large": skipped.too_large += 1; break;
		case "changed-during-read":
		case "not-found":
		case "not-file": skipped.changed += 1; break;
		default: break;
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

function asNonEmpty<T>(values: readonly T[]): readonly [T, ...T[]] {
	const first = values[0];
	if (first === undefined) throw new RangeError("expected a non-empty collection");
	return [first, ...values.slice(1)];
}

function compareRegion(left: VerifiedCodeRegion, right: VerifiedCodeRegion): number {
	return compareStableString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareStableString(left.id, right.id);
}

function compareStableString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function validLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}

/** 阶段 4 先展示 scanner 保存的紧凑窗口；完整正文仅用于当前版本区域化。 */
export function strictRegionContent(region: VerifiedCodeRegion): string {
	const hit = region.verifiedHits[0];
	return [...hit.before, hit.lineText, ...hit.after].join("\n");
}
