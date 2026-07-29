import { fail, type ToolOutcome } from "../shared/result.js";
import type { GrepParams } from "./types.js";

export interface QueryPlan {
	readonly query: string;
	readonly paths: readonly string[];
	readonly glob?: string;
	readonly targetTerms: readonly string[];
	readonly targetQuery: string;
	readonly structuredQuery?: string;
	readonly regex: RegExp;
}

/** 将公开参数归一化为不依赖 filesystem 或增强来源的确定性查询计划。 */
export function createQueryPlan(params: GrepParams): ToolOutcome<QueryPlan> {
	if (typeof params.query !== "string" || params.query.trim().length === 0) {
		return fail("INVALID_OPERATION", "query must not be empty.");
	}
	if (params.query.includes("\0")) return fail("INVALID_OPERATION", "query must not contain NUL bytes.");
	const paths = params.path ?? ["."];
	if (!Array.isArray(paths) || paths.length === 0) return fail("INVALID_PATH", "path must contain at least one scope.");
	for (const scope of paths) {
		if (typeof scope !== "string" || scope.length === 0) return fail("INVALID_PATH", "path entries must be non-empty strings.");
		if (scope.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: scope });
	}
	if (/[\r\n]/u.test(params.query)) {
		return fail("INVALID_OPERATION", "query must not contain CR or LF.", { path: paths[0] ?? "." });
	}
	if (params.glob !== undefined && (typeof params.glob !== "string" || params.glob.length === 0 || params.glob.includes("\0"))) {
		return fail("INVALID_PATH", "glob must be a non-empty string without NUL bytes.", { path: paths[0] ?? "." });
	}
	const regex = compileLineRegex(params.query, paths[0] ?? ".");
	if ("status" in regex) return regex;
	const targetTerms = lexicalTerms(params.query);
	const structuredQuery = isStructuredQuery(params.query) ? params.query : undefined;
	return {
		query: params.query,
		paths: [...paths],
		...(params.glob === undefined ? {} : { glob: params.glob }),
		targetTerms,
		targetQuery: targetTerms.join(" "),
		...(structuredQuery === undefined ? {} : { structuredQuery }),
		regex,
	};
}

export function compileLineRegex(query: string, path = "."): RegExp | ReturnType<typeof fail> {
	try {
		return new RegExp(query, "u");
	} catch (error) {
		return fail("INVALID_REGEX", error instanceof Error ? error.message : "Invalid regular expression.", { path });
	}
}

function lexicalTerms(value: string): string[] {
	return value.match(/[$_\p{L}\p{N}]+(?:[.:#][$_\p{L}\p{N}]+)*/gu) ?? [];
}

function isStructuredQuery(value: string): boolean {
	return /^[$_\p{L}\p{N}]+(?:[./:#-][$_\p{L}\p{N}]+)*$/u.test(value);
}
