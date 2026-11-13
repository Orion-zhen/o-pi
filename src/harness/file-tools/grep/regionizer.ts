import { enclosingCodeUnits } from "../../code-index/enclosing-units.ts";
import { hasStructuralRange } from "../../code-index/structure.ts";
import type { AnalyzedFileIndex, IndexedCodeUnit } from "../../code-index/types.ts";
import { fail, mapFsError, type ToolOutcome } from "../shared/result.ts";
import {
	createSemanticCodeRegion,
	createVerifiedCodeRegion,
	type CodeRegion,
	type RegionEvidence,
	type TextHit,
	type VerifiedCodeRegion,
} from "./candidates.ts";
import { GrepDocuments, type GrepDocument } from "./documents.ts";
import type { ScopedFile } from "./inventory.ts";
import { AbortGrepParse } from "./parser-pool.ts";
import { compactGrepSkippedFiles, createGrepSkippedFiles, recordSkippedFile } from "./skipped.ts";
import type { GrepScopeError, GrepSkippedFiles } from "./types.ts";
import { codeRegionMetadata } from "./unit-metadata.ts";

export interface RegionizedFile {
	readonly document: GrepDocument;
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

/** 只装配区域，正文准入、加载和语法复用统一由 documents 负责。 */
export async function regionize(
	documents: GrepDocuments,
	hits: readonly TextHit[],
	priorityFiles: readonly ScopedFile[],
	semantic: readonly SemanticRegionizedFile[],
	related: boolean,
	signal: AbortSignal,
): Promise<ToolOutcome<RegionizationResult>> {
	const combined = new Map<string, RegionizedFile>(semantic.map((file) => [file.document.path, file]));
	const excludedHitPaths = new Set<string>();
	const prepared: GrepDocument[] = [];
	const scopeErrors: GrepScopeError[] = [];
	const skipped = createGrepSkippedFiles();
	let astSkippedOversizedFiles = 0;
	for (const file of priorityFiles) {
		if (signal.aborted) return aborted();
		if (combined.has(file.path)) continue;
		if (file.snapshot.sizeBytes > documents.maxFileBytes) {
			astSkippedOversizedFiles += 1;
			continue;
		}
		const loaded = await documents.load(file.path);
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
		if (loaded.value !== undefined) prepared.push(loaded.value);
	}
	try {
		for (const { document, analysis } of await documents.analyze(prepared)) {
			if (analysis.status === "parsed") combined.set(document.path, { document, analysis });
		}
	} catch (error) {
		if (signal.aborted || error instanceof AbortGrepParse) return aborted();
		throw error;
	}
	if (signal.aborted) return aborted();
	const files = [...combined.values()].sort((left, right) => compareString(left.document.path, right.document.path));
	const relatedIds = new Set(related ? semantic.flatMap((file) => file.selectedIds) : []);
	return {
		regions: regionizeAnalyzedFiles(hits.filter((hit) => !excludedHitPaths.has(hit.path)), files, relatedIds),
		files, astSkippedOversizedFiles, skipped: compactGrepSkippedFiles(skipped), scopeErrors,
	};
}

/** 将已接纳的代码单元映射为区域，未归属的正文命中保留为文本。 */
export function regionizeAnalyzedFiles(
	hits: readonly TextHit[],
	files: readonly RegionizedFile[],
	relatedIds: ReadonlySet<string>,
): CodeRegion[] {
	const fallback = groupHits(hits);
	const regions: CodeRegion[] = [];
	for (const file of files) {
		const fileHits = fallback.get(file.document.path);
		const units = new Map(file.analysis.units.map((unit) => [unit.id, unit]));
		const parsed = fileHits === undefined ? [] : parsedRegions(file.document.file, fileHits, units);
		regions.push(...parsed);
		const mappedHits = new Set(parsed.flatMap((region) => region.verifiedHits));
		const [firstOutside, ...remainingOutside] = (fileHits ?? []).filter((hit) => !mappedHits.has(hit));
		if (firstOutside === undefined) fallback.delete(file.document.path);
		else fallback.set(file.document.path, [firstOutside, ...remainingOutside]);
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
	return regions.sort((left, right) => compareString(left.path, right.path)
		|| left.startLine - right.startLine || left.endLine - right.endLine || compareString(left.id, right.id));
}

function groupHits(hits: readonly TextHit[]): Map<string, [TextHit, ...TextHit[]]> {
	const hitsByPath = new Map<string, [TextHit, ...TextHit[]]>();
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
	const enclosing = enclosingCodeUnits([...units.values()].filter(hasStructuralRange),
		hits.map((hit) => ({ startByte: hit.byteStart, endByte: hit.byteEnd })));
	const grouped = new Map<string, { readonly unit: IndexedCodeUnit; readonly hits: [TextHit, ...TextHit[]] }>();
	for (const [index, hit] of hits.entries()) {
		const unit = enclosing[index];
		if (unit === undefined) continue;
		const existing = grouped.get(unit.id);
		if (existing === undefined) grouped.set(unit.id, { unit, hits: [hit] });
		else existing.hits.push(hit);
	}
	return [...grouped.values()].map(({ unit, hits }) => createVerifiedCodeRegion({
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
		evidence: textEvidence(hits[0].matchMode),
	}, hits));
}

function textRegions(hits: readonly [TextHit, ...TextHit[]]): VerifiedCodeRegion[] {
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
	return { source: matchMode === "literal" ? "text-literal" : "text-regex", rank: 1 };
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}
