import { languageFromPath, type AnalyzedFileIndex, type IndexedCodeUnit } from "../../code-index/parser.js";
import type { TextContent } from "../../filesystem/contracts/content.js";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.js";
import { createVerifiedCodeRegion, type RegionEvidence, type TextHit, type VerifiedCodeRegion } from "./candidates.js";
import type { ScopeInventory, ScopedFile } from "./inventory.js";
import { AbortGrepParse, GrepParser } from "./parser-pool.js";
import { assignSourceLocalRanks } from "./ranking.js";
import type { GrepScopeError, GrepSkippedFiles, TruncationReason } from "./types.js";

const AST_CACHE_MAX_ENTRIES = 2_048;

interface CachedAst {
	readonly analysis: AnalyzedFileIndex;
}

interface PreparedFile {
	readonly file: ScopedFile;
	readonly content: TextContent;
	readonly hits: readonly TextHit[];
	readonly cacheKey: string;
	readonly cached?: CachedAst;
}

interface RegionizeFile {
	readonly file: ScopedFile;
	readonly hits: readonly TextHit[];
}

export interface AutoRegionizedFile {
	readonly file: ScopedFile;
	readonly content: TextContent;
	readonly analysis: AnalyzedFileIndex;
}

export interface AutoRegionizationResult extends RegionizationResult {
	readonly files: readonly AutoRegionizedFile[];
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
	readonly astMaxFileBytes: number;
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
		if (!validLimit(context.astMaxFileBytes)) {
			return fail("INVALID_OPERATION", "AST file byte limit must be a non-negative safe integer.");
		}
		const files = hitFiles(inventory, hits);
		const rankByHit = textHitSourceRanks(hits);
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
		let parsedFiles = 0;

		for (const candidate of files) {
			if (isAborted(context.operation.signal)) return aborted(candidate.file.path);
			if (languageFromPath(candidate.file.path) === "text") {
				fallback.set(candidate.file.path, candidate.hits);
				continue;
			}
			if (candidate.file.snapshot.sizeBytes > context.astMaxFileBytes) {
				semanticLimited = true;
				fallback.set(candidate.file.path, candidate.hits);
				continue;
			}
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
				fallback.set(file.file.path, asNonEmpty(file.hits));
				continue;
			}
			parsedFiles += 1;
			const parsed = parsedRegions({ ...file, hits: asNonEmpty(file.hits) }, analysis.index.units, rankByHit);
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

	async regionizeAuto(
		inventory: ScopeInventory,
		hits: readonly TextHit[],
		priorityPaths: readonly string[],
		context: RegionizerContext,
	): Promise<ToolOutcome<AutoRegionizationResult>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		if (!validLimit(context.astMaxFileBytes)) {
			return fail("INVALID_OPERATION", "AST file byte limit must be a non-negative safe integer.");
		}
		const inventoryByPath = new Map(inventory.files.map((file) => [file.path, file]));
		const hitsByPath = groupHits(hits);
		const rankByHit = textHitSourceRanks(hits);
		const fallback = new Map<string, readonly [TextHit, ...TextHit[]]>();
		for (const [path, grouped] of hitsByPath) fallback.set(path, asNonEmpty(grouped));
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
		for (const path of priorityPaths) {
			const file = inventoryByPath.get(path);
			if (file === undefined || languageFromPath(file.path) === "text") continue;
			if (file.snapshot.sizeBytes > context.astMaxFileBytes) {
				semanticLimited = true;
				continue;
			}
			const candidate: RegionizeFile = { file, hits: hitsByPath.get(path) ?? [] };
			const loaded = await this.prepare(candidate, context);
			if (!loaded.ok) {
				if (loaded.error.code === "aborted") return aborted(file.path);
				fallback.delete(file.path);
				if (file.explicitFile) scopeErrors.push({
					path: file.scopeInput,
					error: mapFsError(loaded.error, { notFound: "file", path: file.path }).error,
				});
				else countSkipped(skipped, loaded.error);
				continue;
			}
			if (loaded.value === undefined) {
				fallback.delete(file.path);
				if (file.explicitFile) scopeErrors.push({
					path: file.scopeInput,
					error: fail("STALE_READ", "File changed after text scanning.", { path: file.path }).error,
				});
				else skipped.changed += 1;
				continue;
			}
			if (hasBareCr(loaded.value.content.text)) continue;
			prepared.push(loaded.value);
		}
		const analyses = await this.analyzePrepared(prepared, context.operation.signal);
		if (analyses.status === "failed") return analyses;
		const files: AutoRegionizedFile[] = [];
		const regions: Array<{ readonly order: number; readonly region: VerifiedCodeRegion }> = [];
		let parsedFiles = 0;
		for (const [index, file] of prepared.entries()) {
			const analysis = analyses.values[index];
			if (analysis === undefined || analysis.status !== "parsed") continue;
			parsedFiles += 1;
			files.push({ file: file.file, content: file.content, analysis });
			if (file.hits.length === 0) continue;
			const parsed = parsedRegions({ ...file, hits: asNonEmpty(file.hits) }, analysis.index.units, rankByHit);
			for (const region of parsed) {
				regions.push({ order: rankByHit.get(region.verifiedHits[0]) ?? Number.MAX_SAFE_INTEGER, region });
			}
			const mappedHits = new Set(parsed.flatMap((region) => region.verifiedHits));
			const outside = file.hits.filter((hit) => !mappedHits.has(hit));
			if (outside.length === 0) fallback.delete(file.file.path);
			else fallback.set(file.file.path, asNonEmpty(outside));
		}
		for (const fileHits of fallback.values()) {
			for (const region of textRegions(fileHits, rankByHit)) {
				regions.push({ order: rankByHit.get(region.verifiedHits[0]) ?? Number.MAX_SAFE_INTEGER, region });
			}
		}
		regions.sort((left, right) => left.order - right.order || compareRegion(left.region, right.region));
		return {
			regions: regions.map((item) => item.region),
			files,
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
		candidate: RegionizeFile,
		context: RegionizerContext,
	): Promise<{ readonly ok: true; readonly value: PreparedFile | undefined } | { readonly ok: false; readonly error: FsError }> {
		const loaded = await context.filesystem.content.readText(candidate.file.ref, {
			maxBytes: context.astMaxFileBytes,
			expectedSnapshot: candidate.file.snapshot,
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
				if (analysis !== undefined) this.cacheSet(file.cacheKey, { analysis });
			}
			if (analysis === undefined) {
				analysis = {
					index: { id: file.file.snapshot.identity, path: file.file.path, language: languageFromPath(file.file.path), units: [], symbols: [] },
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

function groupHits(hits: readonly TextHit[]): Map<string, TextHit[]> {
	const hitsByPath = new Map<string, TextHit[]>();
	for (const hit of hits) {
		const grouped = hitsByPath.get(hit.path);
		if (grouped === undefined) hitsByPath.set(hit.path, [hit]);
		else grouped.push(hit);
	}
	return hitsByPath;
}

function hitFiles(inventory: ScopeInventory, hits: readonly TextHit[]): Array<RegionizeFile & { readonly hits: readonly [TextHit, ...TextHit[]] }> {
	const hitsByPath = groupHits(hits);
	const result: Array<RegionizeFile & { readonly hits: readonly [TextHit, ...TextHit[]] }> = [];
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
		const unit = units
			.filter((candidate) => candidate.startByte <= hit.byteStart && hit.byteEnd <= candidate.endByte)
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
			...(unit.signature === undefined ? {} : { declaration: unit.signature }),
			...(unit.declarationEndByte === undefined ? {} : { declarationEndByte: unit.declarationEndByte }),
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
		startLine: hit.line,
		endLine: hit.line,
		startByte: hit.byteStart,
		endByte: hit.byteEnd,
		kind: "text",
		roles: ["text"],
		signals: ["verified_text_line"],
		evidence: [textEvidence(hit, rankByHit)],
	}, [hit]));
}

function textHitSourceRanks(hits: readonly TextHit[]): ReadonlyMap<TextHit, number> {
	return assignSourceLocalRanks(
		hits,
		(hit) => hit.mode === "literal" ? "text-literal" : "text-regex",
		(left, right) => compareStableString(left.path, right.path)
			|| left.line - right.line
			|| left.byteStart - right.byteStart
			|| left.byteEnd - right.byteEnd,
	);
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
		file.snapshot.identity,
		file.path,
		file.snapshot.version,
		hash,
	].join("\0");
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
