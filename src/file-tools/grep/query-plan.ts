import { fail, type FailedResult, type ToolOutcome } from "../shared/result.js";
import type { GrepParams } from "./types.js";

interface QueryPlanBase {
	readonly query: string;
	readonly paths: readonly string[];
	readonly glob?: string;
	readonly targetTerms: readonly string[];
	readonly targetQuery: string;
	readonly structuredQuery?: string;
	readonly regex: RegExp;
}

export type QueryPlan = QueryPlanBase & (
	| {
		readonly queryMode: "regex";
		readonly invalidRegex?: never;
	}
	| {
		readonly queryMode: "literal_fallback";
		readonly invalidRegex: FailedResult;
	}
);

type QueryMatcher =
	| {
		readonly queryMode: "regex";
		readonly regex: RegExp;
	}
	| {
		readonly queryMode: "literal_fallback";
		readonly regex: RegExp;
		readonly invalidRegex: FailedResult;
	};

const REGEX_RECOVERY_HINTS: Readonly<Record<string, string>> = {
	"Unterminated group": "Escape a literal opening parenthesis, or close the regular-expression group.",
	"Unmatched ')'": "Escape the literal closing parenthesis, or remove the unmatched group terminator.",
	"Unterminated character class": "Escape a literal opening bracket, or close the character class with a closing bracket.",
	"\\ at end of pattern": "Remove the trailing backslash, or escape it as a literal backslash.",
	"Range out of order in character class": "Reorder the character-class range endpoints, or escape the hyphen as literal text.",
	"Nothing to repeat": "Remove the misplaced or repeated quantifier, or escape it as literal text.",
	"numbers out of order in {} quantifier": "Make the quantifier minimum no greater than its maximum, or escape the braces as literal text.",
	"Invalid group": "Use a supported ECMAScript group form, or escape the opening parenthesis as literal text.",
	"Duplicate capture group name": "Give each named capture group a unique name, or make the group non-capturing.",
	"Invalid capture group name": "Use a valid identifier for the capture group name, or remove the name.",
	"Invalid named capture referenced": "Define the referenced named capture, or correct the backreference name.",
	"Invalid Unicode escape": "Use a valid Unicode escape, or escape the backslash as literal text.",
	"Invalid property name": "Use a supported Unicode property escape name, or escape the backslash as literal text.",
};

/** 将公开参数归一化为不依赖 filesystem 或增强来源的确定性查询计划。 */
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
	const matcher = compileLineQuery(params.query, paths[0] ?? ".");
	const targetTerms = lexicalTerms(params.query);
	const structuredQuery = isStructuredQuery(params.query) ? params.query : undefined;
	const base: QueryPlanBase = {
		query: params.query,
		paths: [...paths],
		...(params.glob === undefined ? {} : { glob: params.glob }),
		targetTerms,
		targetQuery: targetTerms.join(" "),
		...(structuredQuery === undefined ? {} : { structuredQuery }),
		regex: matcher.regex,
	};
	return matcher.queryMode === "regex"
		? { ...base, queryMode: "regex" }
		: { ...base, queryMode: "literal_fallback", invalidRegex: matcher.invalidRegex };
}

function compileLineQuery(
	query: string,
	path: string,
): QueryMatcher {
	try {
		return { queryMode: "regex", regex: new RegExp(query, "u") };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid regular expression.";
		return {
			queryMode: "literal_fallback",
			regex: new RegExp(escapeRegexLiteral(query), "u"),
			invalidRegex: fail("INVALID_REGEX", message, {
				path,
				next: regexRecoveryHint(message),
			}),
		};
	}
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function regexRecoveryHint(message: string): string {
	const reason = regexErrorReason(message);
	return REGEX_RECOVERY_HINTS[reason]
		?? "Escape literal metacharacters, or provide a valid ECMAScript regular expression.";
}

function regexErrorReason(message: string): string {
	const marker = message.lastIndexOf("/u: ");
	return marker < 0 ? message : message.slice(marker + 4);
}

function lexicalTerms(value: string): string[] {
	return value.match(/[$_\p{L}\p{N}]+(?:[.:#][$_\p{L}\p{N}]+)*/gu) ?? [];
}

function isStructuredQuery(value: string): boolean {
	return /^[$_\p{L}\p{N}]+(?:[./:#-][$_\p{L}\p{N}]+)*$/u.test(value);
}
