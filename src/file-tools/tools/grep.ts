import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { fail, isFailed } from "../core/errors.js";
import { getGrepIndex } from "../grep/indexer.js";
import { decodeTextFile } from "../core/text-file.js";
import { packGrepResults, renderGrepSuccess, selectGrepCandidatesForPacking } from "../grep/packer.js";
import { rankGrepRegions, type RankedGrepRegion } from "../grep/ranker.js";
import { byteRangeForLines, type IndexedCodeUnit } from "../../code-index/parser.js";
import type { FileToolLspHooks, FileToolLspSymbolCandidate, GrepMatchMode, GrepParams, GrepSuccess, ToolOutcome } from "../types.js";
import type { RepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";
import type { RepoMapQueryCandidate } from "../../repo-map/query.js";

interface NormalizedGrepParams {
	query: string;
	path: string;
	match: GrepMatchMode;
	glob?: string;
}

export interface GrepRuntime {
	/** 可选 LSP symbol 后端；命中仍需经过 grep scope、ignore 和预算过滤。 */
	lsp?: FileToolLspHooks;
	/** 可选源码读取器；默认读取本地 UTF-8 文件。 */
	readSourceText?: (file: { path: string; absolutePath: string }, signal: AbortSignal | undefined) => Promise<ToolOutcome<string>>;
	/** 可选 Repo Map 查询层；activation、generation 与 freshness gate 由实现方封装。 */
	repoMap?: RepoMapFileToolQuery;
}

/** grep 是单入口代码检索器：自动路由文本、symbol、regex 和一跳关系，返回预算内代码区域。 */
export async function grepWorkspaceFiles(cwd: string, params: GrepParams, signal?: AbortSignal, runtime: GrepRuntime = {}): Promise<ToolOutcome<GrepSuccess>> {
	const validation = validateGrepParams(params);
	if (isFailed(validation)) return validation;
	const regex = validation.match === "regex" ? compileRegex(validation.query) : undefined;
	if (isFailed(regex)) return regex;
	const index = await getGrepIndex(cwd, validation, signal);
	if (isFailed(index)) return index;
	const sourceText = new Map(index.sourceText);
	const filesByPath = new Map(index.files.map((file) => [file.path, file]));
	const rankInput = {
		query: validation.query,
		match: validation.match,
		files: index.files.map((file) => ({ path: file.path, units: file.index.units })),
		sourceText,
		allowMetadataCandidates: validation.match !== "auto",
		...(regex !== undefined ? { regex } : {}),
	};
	let ranked = rankGrepRegions(rankInput);
	const repoMapResult = validation.match === "auto"
		? await safeRepoMapCandidates(runtime.repoMap, {
			requestedPath: index.root.realPath,
			query: validation.query,
			limit: Math.max(24, index.config.limits.grep_result_limit * 6),
		})
		: undefined;
	const lspSymbolCandidates = await safeLspSymbolCandidates(runtime.lsp, {
		workspaceRoot: index.workspaceRoot,
		query: validation.query,
		path: index.root.relativePath,
	}, validation.match);
	const allowedPaths = new Set(index.files.map((file) => file.path));
	const scopedRepoMapCandidates = repoMapResult?.candidates.filter((candidate) =>
		allowedPaths.has(candidate.path)
		&& candidate.relatedEdges.every((edge) => edge.relatedFiles.every((file) => allowedPaths.has(file.path)))) ?? [];
	const lspSource = await loadCandidateSourceText(
		sourceText,
		filesByPath,
		limitedUniquePaths(lspSymbolCandidates.map((candidate) => candidate.path), index.config.limits.grep_result_limit * 4),
		signal,
		runtime,
	);
	if (isFailed(lspSource)) return lspSource;
	const repoMapSource = await loadCandidateSourceText(
		sourceText,
		filesByPath,
		limitedUniquePaths(
			scopedRepoMapCandidates.flatMap((candidate) => [candidate.path, ...candidate.relatedEdges.flatMap((edge) => edge.relatedFiles.map((file) => file.path))]),
			index.config.limits.grep_result_limit * 10,
		),
		signal,
		runtime,
	);
	if (isFailed(repoMapSource)) return repoMapSource;
	let lspCandidates = lspRegionsFromCandidates(lspSymbolCandidates, validation.match, sourceText, allowedPaths);
	let repoMapCandidates = repoMapRegionsFromCandidates(scopedRepoMapCandidates, index.files, sourceText);
	const regions = mergeRanked(mergeRanked(ranked.regions, lspCandidates), repoMapCandidates);
	const hydrated = await loadCandidateSourceText(sourceText, filesByPath, hydrationPaths(regions, index.config.limits.grep_result_limit), signal, runtime);
	if (isFailed(hydrated)) return hydrated;
	ranked = rankGrepRegions({
		...rankInput,
		sourceText,
		allowMetadataCandidates: false,
	});
	lspCandidates = lspRegionsFromCandidates(lspSymbolCandidates, validation.match, sourceText, allowedPaths);
	repoMapCandidates = repoMapRegionsFromCandidates(scopedRepoMapCandidates, index.files, sourceText);
	let finalRegions = mergeRanked(mergeRanked(ranked.regions, lspCandidates), repoMapCandidates);
	if (validation.match !== "auto" && finalRegions.length === 0) {
		const scanned = await scanFallbackSourceText({
			sourceText,
			files: index.files,
			query: validation.query,
			match: validation.match,
			regex,
			signal,
			runtime,
			limit: Math.max(1, index.config.limits.grep_result_limit),
		});
		if (isFailed(scanned)) return scanned;
		ranked = rankGrepRegions({
			...rankInput,
			sourceText,
			allowMetadataCandidates: false,
		});
		finalRegions = mergeRanked(mergeRanked(ranked.regions, lspCandidates), repoMapCandidates);
	}
	const strategy = [...ranked.strategy];
	if (lspCandidates.length > 0) strategy.push("lsp");
	if (repoMapCandidates.length > 0) strategy.push("repo-map");
	return packGrepResults({
		query: validation.query,
		path: index.root.relativePath,
		match: validation.match,
		strategy,
		totalCandidates: finalRegions.length,
		regions: finalRegions,
		sourceText,
		tokenBudget: index.config.limits.grep_output_token_budget,
		resultLimit: index.config.limits.grep_result_limit,
		skipped: index.skipped,
		scanComplete: index.scanComplete,
		nearSymbols: ranked.nearSymbols,
	});
}

async function safeRepoMapCandidates(
	queryLayer: RepoMapFileToolQuery | undefined,
	input: { requestedPath: string; query: string; limit: number },
): Promise<Awaited<ReturnType<RepoMapFileToolQuery["query"]>>> {
	if (queryLayer === undefined) return undefined;
	try {
		return await queryLayer.query(input);
	} catch {
		return undefined;
	}
}

export function formatCompactGrepResult(result: GrepSuccess): string {
	return renderGrepSuccess(result);
}

function validateGrepParams(params: GrepParams): ToolOutcome<NormalizedGrepParams> {
	if (typeof params.query !== "string" || params.query.length === 0) return fail("INVALID_OPERATION", "query must not be empty.");
	if (params.query.includes("\0")) return fail("INVALID_OPERATION", "query must not contain NUL bytes.");
	const path = params.path ?? ".";
	if (typeof path !== "string" || path.length === 0) return fail("INVALID_PATH", "path must not be empty.", { path });
	if (path.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path });
	const match = params.match ?? "auto";
	if (match !== "auto" && match !== "literal" && match !== "regex") return fail("INVALID_OPERATION", "match must be auto, literal, or regex.", { path });
	if (params.glob !== undefined && (typeof params.glob !== "string" || params.glob.length === 0)) {
		return fail("INVALID_PATH", "glob must not be empty.", { path });
	}
	return {
		query: params.query,
		path,
		match,
		...(params.glob !== undefined ? { glob: params.glob } : {}),
	};
}

function compileRegex(query: string): ToolOutcome<RegExp> {
	try {
		return new RegExp(query, "gu");
	} catch (error) {
		return fail("INVALID_REGEX", "query is not a valid regular expression.", {
			details: { error: error instanceof Error ? error.message : String(error) },
		});
	}
}

async function loadCandidateSourceText(
	sourceText: Map<string, string>,
	filesByPath: Map<string, { path: string; absolutePath: string }>,
	paths: string[],
	signal: AbortSignal | undefined,
	runtime: GrepRuntime,
): Promise<ToolOutcome<Map<string, string>>> {
	for (const filePath of new Set(paths)) {
		if (sourceText.has(filePath)) continue;
		const file = filesByPath.get(filePath);
		if (file === undefined) continue;
		if (signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		const loaded = await (runtime.readSourceText ?? defaultReadSourceText)(file, signal);
		if (isFailed(loaded)) {
			if (loaded.error.code === "OPERATION_ABORTED") return loaded;
			continue;
		}
		sourceText.set(file.path, loaded);
	}
	return sourceText;
}

async function defaultReadSourceText(file: { path: string; absolutePath: string }, signal: AbortSignal | undefined): Promise<ToolOutcome<string>> {
	let bytes: Buffer;
	try {
		bytes = signal === undefined ? await readFile(file.absolutePath) : await readFile(file.absolutePath, { signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		return fail("FILE_NOT_FOUND", "File cannot be read.", { path: file.path });
	}
	const decoded = decodeTextFile(bytes, file.path);
	if (isFailed(decoded)) return decoded;
	return decoded.text;
}

async function safeLspSymbolCandidates(
	hooks: FileToolLspHooks | undefined,
	input: Parameters<NonNullable<FileToolLspHooks["grepSymbols"]>>[0],
	match: GrepMatchMode,
): Promise<FileToolLspSymbolCandidate[]> {
	if (hooks?.grepSymbols === undefined || match !== "auto" || !looksLikeSymbol(input.query)) return [];
	try {
		return await hooks.grepSymbols(input);
	} catch {
		return [];
	}
}

function lspRegionsFromCandidates(
	candidates: FileToolLspSymbolCandidate[],
	match: GrepMatchMode,
	sourceText: Map<string, string>,
	allowedPaths: Set<string>,
): RankedGrepRegion[] {
	if (match !== "auto") return [];
	const ranked: RankedGrepRegion[] = [];
	for (const candidate of candidates) {
		if (!allowedPaths.has(candidate.path)) continue;
		const text = sourceText.get(candidate.path);
		if (text === undefined) continue;
		const range = byteRangeForLines(text, candidate.start_line, candidate.end_line);
		ranked.push({
			id: `${candidate.path}:${range.startByte}:${range.endByte}:lsp:${candidate.symbol}`,
			path: candidate.path,
			kind: candidate.kind,
			startLine: candidate.start_line,
			endLine: candidate.end_line,
			startByte: range.startByte,
			endByte: range.endByte,
			symbol: candidate.symbol,
			...(candidate.signature !== undefined ? { signature: candidate.signature } : {}),
			score: candidate.reason === "lsp exact symbol" ? 980 : 720,
			reasons: [candidate.reason],
			matchLines: [candidate.start_line],
			callers: [],
			callees: [],
			imports: [],
		});
	}
	return ranked;
}

function repoMapRegionsFromCandidates(
	candidates: RepoMapQueryCandidate[],
	files: Array<{ path: string; contentHash: string; index: { units: IndexedCodeUnit[] } }>,
	sourceText: ReadonlyMap<string, string>,
): RankedGrepRegion[] {
	const filesByPath = new Map(files.map((file) => [file.path, file]));
	const result: RankedGrepRegion[] = [];
	for (const candidate of candidates) {
		const file = filesByPath.get(candidate.path);
		const text = sourceText.get(candidate.path);
		if (file === undefined || text === undefined || candidate.contentHash === undefined) continue;
		if (hashText(text) !== candidate.contentHash) continue;
		if (!candidate.relatedEdges.every((edge) => edge.relatedFiles.every((related) => {
			const relatedText = sourceText.get(related.path);
			return related.contentHash !== undefined && relatedText !== undefined && hashText(relatedText) === related.contentHash;
		}))) continue;
		const liveUnit = candidate.symbol === undefined
			? file.index.units[0]
			: file.index.units.find((unit) => unit.id === candidate.symbol?.id);
		if (liveUnit === undefined) continue;
		const reasons = repoMapReasons(candidate);
		result.push({
			id: liveUnit.id,
			path: liveUnit.path,
			kind: liveUnit.kind,
			startLine: liveUnit.startLine,
			endLine: liveUnit.endLine,
			startByte: liveUnit.startByte,
			endByte: liveUnit.endByte,
			...(liveUnit.qualifiedName ?? liveUnit.name ? { symbol: liveUnit.qualifiedName ?? liveUnit.name } : {}),
			...(liveUnit.signature !== undefined ? { signature: liveUnit.signature } : {}),
			score: repoMapGrepScore(candidate),
			reasons,
			matchLines: [],
			unit: liveUnit,
			callers: [],
			callees: liveUnit.calls.slice(0, 6),
			imports: liveUnit.imports.slice(0, 4),
		});
	}
	return result;
}

function repoMapReasons(candidate: RepoMapQueryCandidate): string[] {
	const reasons: string[] = candidate.reasons.filter((reason) => reason !== "short symbol" && reason !== "signature");
	if (candidate.reasons.includes("short symbol")) reasons.push("exact symbol");
	if (candidate.reasons.includes("signature")) reasons.push("symbol signature");
	if (candidate.hop > 0) reasons.push(`repo-map hop ${candidate.hop}`);
	for (const alias of candidate.matchedAliases.slice(0, 2)) reasons.push(`alias ${alias.term}→${alias.canonical} (${alias.source})`);
	return Array.from(new Set(reasons));
}

function repoMapGrepScore(candidate: RepoMapQueryCandidate): number {
	if (candidate.reasons.includes("exact qualified symbol")) return 940;
	if (candidate.reasons.includes("exact symbol") || candidate.reasons.includes("short symbol")) return 880;
	if (candidate.reasons.includes("alias")) return Math.max(420, 760 - candidate.hop * 150);
	if (candidate.reasons.includes("definition")) return candidate.reasons.includes("export") ? 840 : 800;
	if (candidate.reasons.includes("public api")) return 780;
	if (candidate.reasons.includes("registration") || candidate.reasons.includes("entrypoint")) return 700;
	if (candidate.reasons.includes("component") || candidate.reasons.includes("package")) return 520;
	if (candidate.reasons.includes("caller")) return 390;
	if (candidate.reasons.includes("reference")) return 360;
	if (candidate.reasons.includes("callee")) return 340;
	if (candidate.reasons.includes("import")) return 250;
	return 220;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function hydrationPaths(regions: RankedGrepRegion[], resultLimit: number): string[] {
	const limit = Math.max(resultLimit * 4, resultLimit + 8);
	return selectGrepCandidatesForPacking(regions, limit).map((region) => region.path);
}

function limitedUniquePaths(paths: string[], limit: number): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const filePath of paths) {
		if (seen.has(filePath)) continue;
		seen.add(filePath);
		result.push(filePath);
		if (result.length >= limit) break;
	}
	return result;
}

async function scanFallbackSourceText(input: {
	sourceText: Map<string, string>;
	files: Array<{ path: string; absolutePath: string }>;
	query: string;
	match: GrepMatchMode;
	regex: RegExp | undefined;
	signal: AbortSignal | undefined;
	runtime: GrepRuntime;
	limit: number;
}): Promise<ToolOutcome<void>> {
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	let loaded = 0;
	for (const file of input.files) {
		if (loaded >= input.limit) return;
		if (input.sourceText.has(file.path)) continue;
		if (input.signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		const matched = await fileHasLineMatch(file, input.query, input.match, input.regex, input.signal);
		if (isFailed(matched)) {
			if (matched.error.code === "OPERATION_ABORTED") return matched;
			continue;
		}
		if (!matched) continue;
		const source = await loadCandidateSourceText(input.sourceText, filesByPath, [file.path], input.signal, input.runtime);
		if (isFailed(source)) return source;
		loaded += 1;
	}
}

async function fileHasLineMatch(
	file: { path: string; absolutePath: string },
	query: string,
	match: GrepMatchMode,
	regex: RegExp | undefined,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<boolean>> {
	const stream = createReadStream(file.absolutePath, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
			if (match === "regex") {
				if (regex?.test(line) === true) {
					if (regex.global) regex.lastIndex = 0;
					return true;
				}
				if (regex?.global === true) regex.lastIndex = 0;
			} else if (line.includes(query)) {
				return true;
			}
		}
		return false;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		return fail("FILE_NOT_FOUND", "File cannot be read.", { path: file.path });
	} finally {
		lines.close();
		stream.destroy();
	}
}

function mergeRanked(primary: RankedGrepRegion[], lsp: RankedGrepRegion[]): RankedGrepRegion[] {
	if (lsp.length === 0) return primary;
	const byId = new Map<string, RankedGrepRegion>();
	for (const region of [...primary, ...lsp].sort((left, right) => right.score - left.score)) {
		const existing = byId.get(region.id);
		if (existing === undefined) {
			byId.set(region.id, region);
			continue;
		}
		for (const reason of region.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
		for (const caller of region.callers) if (!existing.callers.includes(caller)) existing.callers.push(caller);
		for (const callee of region.callees) if (!existing.callees.includes(callee)) existing.callees.push(callee);
		for (const imported of region.imports) if (!existing.imports.includes(imported)) existing.imports.push(imported);
	}
	return Array.from(byId.values()).sort((left, right) => right.score - left.score || compareStableString(left.path, right.path) || left.startLine - right.startLine);
}

function looksLikeSymbol(query: string): boolean {
	return /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)*$/u.test(query);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
