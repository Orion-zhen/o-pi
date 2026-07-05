import { readFile } from "node:fs/promises";

import { fail, isFailed } from "./errors.js";
import { getGrepIndex } from "./grep-index.js";
import { decodeTextFile } from "./text-file.js";
import { packGrepResults, renderGrepSuccess } from "./grep-packer.js";
import { rankGrepRegions } from "./grep-ranker.js";
import type { GrepMatchMode, GrepParams, GrepSuccess, ToolOutcome } from "./types.js";

interface NormalizedGrepParams {
	query: string;
	path: string;
	match: GrepMatchMode;
	glob?: string;
}

/** grep 是单入口代码检索器：自动路由文本、symbol、regex 和一跳关系，返回预算内代码区域。 */
export async function grepWorkspaceFiles(cwd: string, params: GrepParams, signal?: AbortSignal): Promise<ToolOutcome<GrepSuccess>> {
	const validation = validateGrepParams(params);
	if (isFailed(validation)) return validation;
	const regex = validation.match === "regex" ? compileRegex(validation.query) : undefined;
	if (isFailed(regex)) return regex;
	const index = await getGrepIndex(cwd, validation, signal);
	if (isFailed(index)) return index;
	const sourceText = await loadMissingSourceText(index.sourceText, index.files, signal);
	if (isFailed(sourceText)) return sourceText;
	const ranked = rankGrepRegions({
		query: validation.query,
		match: validation.match,
		files: index.files.map((file) => ({ path: file.path, units: file.index.units })),
		sourceText,
		...(regex !== undefined ? { regex } : {}),
	});
	return packGrepResults({
		query: validation.query,
		path: index.root.relativePath,
		match: validation.match,
		strategy: ranked.strategy,
		totalCandidates: ranked.regions.length,
		regions: ranked.regions,
		sourceText,
		tokenBudget: index.config.limits.grep_output_token_budget,
		resultLimit: index.config.limits.grep_result_limit,
		skipped: index.skipped,
		scanComplete: index.scanComplete,
		nearSymbols: ranked.nearSymbols,
	});
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

async function loadMissingSourceText(
	sourceText: Map<string, string>,
	files: Array<{ path: string; absolutePath: string }>,
	signal: AbortSignal | undefined,
): Promise<ToolOutcome<Map<string, string>>> {
	for (const file of files) {
		if (sourceText.has(file.path)) continue;
		if (signal?.aborted) return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
		let bytes: Buffer;
		try {
			bytes = signal === undefined ? await readFile(file.absolutePath) : await readFile(file.absolutePath, { signal });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return fail("OPERATION_ABORTED", "grep was aborted.", { path: file.path });
			continue;
		}
		const decoded = decodeTextFile(bytes, file.path);
		if (!isFailed(decoded)) sourceText.set(file.path, decoded.text);
	}
	return sourceText;
}
