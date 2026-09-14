import { fail, type ToolOutcome } from "../shared/result.js";
import type { GrepParams, GrepQueryMode } from "./types.js";

export interface QueryPlan {
	readonly query: string;
	readonly queryMode: GrepQueryMode;
	readonly paths: readonly string[];
	readonly glob?: string;
	readonly targetTerms: readonly string[];
	readonly targetQuery: string;
	readonly structuredQuery?: string;
	readonly regex: RegExp;
}

/** 将公开参数归一化为不依赖文件系统或增强来源的确定性查询计划。 */
export function createQueryPlan(params: GrepParams): ToolOutcome<QueryPlan> {
	if (params.query.trim().length === 0) return fail("INVALID_OPERATION", "query must not be empty.");
	if (params.query.includes("\0")) return fail("INVALID_OPERATION", "query must not contain NUL bytes.");
	const paths = params.path ?? ["."];
	for (const scope of paths) {
		if (scope.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: scope });
	}
	if (/[\r\n]/u.test(params.query)) {
		return fail("INVALID_OPERATION", "query must not contain CR or LF.", { path: paths[0] ?? "." });
	}
	if (params.glob?.includes("\0") === true) {
		return fail("INVALID_PATH", "glob must not contain NUL bytes.", { path: paths[0] ?? "." });
	}
	const queryMode = params.mode ?? "regex";
	let regex: RegExp;
	try {
		regex = new RegExp(queryMode === "literal" ? escapeRegexLiteral(params.query) : params.query, "u");
	} catch (error) {
		return fail("INVALID_REGEX", error instanceof Error ? error.message : "Invalid regular expression.", {
			next: 'Fix the regex, or use mode="literal" for exact text.',
		});
	}
	const targetTerms = lexicalTerms(params.query);
	const structuredQuery = isStructuredQuery(params.query) ? params.query : undefined;
	return {
		query: params.query,
		queryMode,
		paths: [...paths],
		...(params.glob === undefined ? {} : { glob: params.glob }),
		targetTerms,
		targetQuery: targetTerms.join(" "),
		...(structuredQuery === undefined ? {} : { structuredQuery }),
		regex,
	};
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function lexicalTerms(value: string): string[] {
	return value.match(/[$_\p{L}\p{N}]+(?:[.:#][$_\p{L}\p{N}]+)*/gu) ?? [];
}

function isStructuredQuery(value: string): boolean {
	return /^[$_\p{L}\p{N}]+(?:[./:#-][$_\p{L}\p{N}]+)*$/u.test(value);
}
