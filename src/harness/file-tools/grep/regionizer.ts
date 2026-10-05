import { compareCodeUnitNesting } from "../../code-index/units.ts";
import { codeRegionMetadata } from "./unit-metadata.ts";
import { languageFromPath } from "../../syntax-tree/grammars.ts";
import type { AnalyzedFileIndex, CodeDocument, IndexedCodeUnit } from "../../code-index/types.ts";
import { hasStructuralRange } from "../../code-index/structure.ts";
import type { TextContent } from "../../filesystem/contracts/content.ts";
import type { FsError, FsOperationContext } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.ts";
import {
	createSemanticCodeRegion,
	createVerifiedCodeRegion,
	type CodeRegion,
	type RegionEvidence,
	type TextHit,
	type VerifiedCodeRegion,
} from "./candidates.ts";
import type { ScopeInventory, ScopedFile } from "./inventory.ts";
import { AbortGrepParse, GrepParser } from "./parser-pool.ts";
import { compactGrepSkippedFiles, createGrepSkippedFiles, recordSkippedFile } from "./skipped.ts";
import type { GrepScopeError, GrepSkippedFiles } from "./types.ts";

const AST_CACHE_MAX_ENTRIES = 2_048;

interface CachedAst {
	readonly analysis: AnalyzedFileIndex;
}

interface PreparedFile {
	readonly file: ScopedFile;
	readonly content: TextContent;
	readonly cacheKey: string;
	readonly cached?: CachedAst;
}

export interface RegionizedFile {
	readonly file: ScopedFile;
	readonly content: TextContent;
	readonly analysis: AnalyzedFileIndex;
}

export interface SemanticRegionizedFile extends RegionizedFile {
	readonly selectedIds: readonly string[];
}

export interface RegionizationResult {
	readonly regions: readonly CodeRegion[];
	readonly files: readonly RegionizedFile[];
	readonly astSkippedOversizedFiles: number;
	readonly skipped: GrepSkippedFiles;
	readonly scopeErrors: readonly GrepScopeError[];
}

export interface RegionizerContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
	readonly astMaxFileBytes: number;
	readonly preloaded?: ReadonlyMap<string, TextContent>;
	readonly semantic: readonly SemanticRegionizedFile[];
	readonly related: boolean;
}

/** 将流式事实命中映射到当前正文的最小代码区域；缓存只保存派生 AST。 */
export class GrepRegionizer {
	private readonly parser = new GrepParser();
	private readonly cache = new Map<string, CachedAst>();
	private disposed = false;

	async regionize(
		inventory: ScopeInventory,
		hits: readonly TextHit[],
		priorityPaths: readonly string[],
		context: RegionizerContext,
	): Promise<ToolOutcome<RegionizationResult>> {
		if (this.disposed || isAborted(context.operation.signal)) return aborted();
		const inventoryByPath = new Map(inventory.files.map((file) => [file.path, file]));
		const combined = new Map<string, RegionizedFile>(context.semantic.map((file) => [file.file.path, file]));
		const excludedHitPaths = new Set<string>();
		const prepared: PreparedFile[] = [];
		const scopeErrors: GrepScopeError[] = [];
		const skipped = createGrepSkippedFiles();
		let astSkippedOversizedFiles = 0;
		for (const path of priorityPaths) {
			if (combined.has(path)) continue;
			const file = inventoryByPath.get(path);
			if (file === undefined || languageFromPath(file.path) === "text") continue;
			if (file.snapshot.sizeBytes > context.astMaxFileBytes) {
				astSkippedOversizedFiles += 1;
				continue;
			}
			const loaded = await this.prepare(file, context);
			if (!loaded.ok) {
				if (loaded.error.code === "aborted") return aborted(file.path);
				excludedHitPaths.add(file.path);
				if (file.explicitFile) scopeErrors.push({
					path: file.scopeInput,
					error: mapFsError(loaded.error, { notFound: "file", path: file.path }).error,
				});
				else recordSkippedFile(skipped, loaded.error);
				continue;
			}
			if (hasBareCr(loaded.value.content.text)) continue;
			prepared.push(loaded.value);
		}
		const analyses = await this.analyzePrepared(prepared, context.operation.signal);
		if (analyses.status === "failed") return analyses;
		const files: RegionizedFile[] = [];
		for (const [index, file] of prepared.entries()) {
			const analysis = analyses.values[index];
			if (analysis === undefined || analysis.status !== "parsed") continue;
			files.push({ file: file.file, content: file.content, analysis });
		}
		for (const file of files) combined.set(file.file.path, file);
		const authorityFiles = [...combined.values()];
		const relatedIds = new Set(context.related ? context.semantic.flatMap((file) => file.selectedIds) : []);
		const regions = regionizeAnalyzedFiles(
			hits.filter((hit) => !excludedHitPaths.has(hit.path)),
			authorityFiles,
			relatedIds,
		);
		return {
			regions,
			files: authorityFiles,
			astSkippedOversizedFiles,
			skipped: compactGrepSkippedFiles(skipped),
			scopeErrors,
		};
	}

	async syntax(document: CodeDocument, filesystem: WorkspaceFileSystem, signal?: AbortSignal): Promise<AnalyzedFileIndex> {
		const cacheKey = astCacheKey(document, document.hash, filesystem);
		const cached = this.cacheGet(cacheKey);
		const result = await this.analyzePrepared([{
			file: document, content: document, cacheKey,
			...(cached === undefined ? {} : { cached }),
		}], signal);
		if (result.status === "failed") throw new AbortGrepParse();
		const analysis = result.values[0];
		if (analysis === undefined) throw new Error("Missing syntax analysis");
		return analysis;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cache.clear();
		this.parser.dispose();
	}

	private async prepare(
		file: ScopedFile,
		context: RegionizerContext,
	): Promise<{ readonly ok: true; readonly value: PreparedFile } | { readonly ok: false; readonly error: FsError }> {
		let content = context.preloaded?.get(file.path);
		if (content === undefined) {
			const loaded = await context.filesystem.content.readText(file.ref, {
				maxBytes: context.astMaxFileBytes,
				expectedSnapshot: file.snapshot,
			});
			if (!loaded.ok) return loaded;
			content = loaded.value;
		}
		const cacheKey = astCacheKey(file, content.hash, context.filesystem);
		const cached = this.cacheGet(cacheKey);
		return {
			ok: true,
			value: {
				file,
				content,
				cacheKey,
				...(cached === undefined ? {} : { cached }),
			},
		};
	}

	private async analyzePrepared(
		files: readonly { file: Pick<ScopedFile, "path">; content: Pick<TextContent, "text">; cacheKey: string; cached?: CachedAst }[],
		signal: AbortSignal | undefined,
	): Promise<{ readonly status: "success"; readonly values: readonly AnalyzedFileIndex[] } | ReturnType<typeof fail>> {
		const pending = files.filter((file) => file.cached === undefined);
		let fresh: readonly AnalyzedFileIndex[];
		try {
			fresh = await this.parser.analyzeFiles(pending.map((file) => ({
				path: file.file.path,
				text: file.content.text,
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
					path: file.file.path,
					language: languageFromPath(file.file.path),
					units: [],
					status: "error",
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

/** 将已接纳的代码单元映射为区域，未归属的正文命中保留为文本。 */
export function regionizeAnalyzedFiles(
	hits: readonly TextHit[],
	files: readonly RegionizedFile[],
	relatedIds: ReadonlySet<string>,
): CodeRegion[] {
	const fallback = new Map<string, readonly [TextHit, ...TextHit[]]>();
	for (const [path, grouped] of groupHits(hits)) fallback.set(path, asNonEmpty(grouped));
	const regions: CodeRegion[] = [];
	for (const file of files) {
		const fileHits = fallback.get(file.file.path) ?? [];
		const units = new Map(file.analysis.units.map((unit) => [unit.id, unit]));
		const parsed = fileHits.length === 0
			? []
			: parsedRegions(file.file, asNonEmpty(fileHits), units);
		regions.push(...parsed);
		const mappedHits = new Set(parsed.flatMap((region) => region.verifiedHits));
		const outside = fileHits.filter((hit) => !mappedHits.has(hit));
		if (outside.length === 0) fallback.delete(file.file.path);
		else fallback.set(file.file.path, asNonEmpty(outside));
		if (relatedIds.size === 0) continue;
		const mappedUnits = new Set(parsed.map((region) => region.id));
		for (const unit of file.analysis.units) {
			if (mappedUnits.has(unit.id) || !relatedIds.has(unit.id)) continue;
			regions.push(createSemanticCodeRegion({
				id: unit.id,
				path: unit.path,
				startLine: unit.startLine,
				endLine: unit.endLine,
				startByte: unit.startByte,
				endByte: unit.endByte,
				kind: unit.kind,
				...codeRegionMetadata(unit, units),
				symbolRole: "definition",
				authority: unit.authority,
				...(unit.navigation === undefined ? {} : { navigation: unit.navigation }),
				...(unit.relationStatus === undefined ? {} : { relationStatus: unit.relationStatus }),
				signals: ["related_symbol"],
			}));
		}
	}
	for (const fileHits of fallback.values()) regions.push(...textRegions(fileHits));
	return regions.sort(compareRegion);
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

function parsedRegions(
	file: ScopedFile,
	hits: readonly [TextHit, ...TextHit[]],
	units: ReadonlyMap<string, IndexedCodeUnit>,
): VerifiedCodeRegion[] {
	const sortedUnits = [...units.values()].filter(hasStructuralRange).sort(compareCodeUnitNesting);
	const grouped = new Map<string, { readonly unit: IndexedCodeUnit; readonly hits: TextHit[] }>();
	for (const hit of hits) {
		const unit = sortedUnits.find((candidate) => candidate.startByte <= hit.byteStart && hit.byteEnd <= candidate.endByte);
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
			path: file.path,
			startLine: unit.startLine,
			endLine: unit.endLine,
			startByte: unit.startByte,
			endByte: unit.endByte,
			kind: unit.kind,
			...codeRegionMetadata(unit, units),
			symbolRole: "enclosing",
			authority: unit.authority,
			...(unit.navigation === undefined ? {} : { navigation: unit.navigation }),
			...(unit.relationStatus === undefined ? {} : { relationStatus: unit.relationStatus }),
			signals: ["verified_enclosing_region"],
			evidence: textEvidence(first.matchMode),
		}, asNonEmpty(sortedHits));
	});
}

function textRegions(
	hits: readonly [TextHit, ...TextHit[]],
): VerifiedCodeRegion[] {
	return hits.map((hit) => createVerifiedCodeRegion({
		id: `${hit.path}:${hit.line}:${hit.byteStart}:${hit.byteEnd}`,
		path: hit.path,
		startLine: hit.line,
		endLine: hit.line,
		startByte: hit.byteStart,
		endByte: hit.byteEnd,
		kind: "text",
		signals: ["verified_text_line"],
		evidence: textEvidence(hit.matchMode),
	}, [hit]));
}

function textEvidence(matchMode: TextHit["matchMode"]): RegionEvidence {
	return {
		source: matchMode === "literal" ? "text-literal" : "text-regex",
		rank: 1,
	};
}

function astCacheKey(file: Pick<ScopedFile, "path">, hash: string, filesystem: WorkspaceFileSystem): string {
	return [filesystem.identity, file.path, hash].join("\0");
}

function hasBareCr(text: string): boolean {
	return /\r(?!\n)/u.test(text);
}

function asNonEmpty<T>(values: readonly T[]): readonly [T, ...T[]] {
	const first = values[0];
	if (first === undefined) throw new RangeError("expected a non-empty collection");
	return [first, ...values.slice(1)];
}

function compareRegion(left: CodeRegion, right: CodeRegion): number {
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


function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}
