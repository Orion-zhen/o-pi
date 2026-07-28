import { fail, type ToolOutcome } from "../shared/result.js";
import type { GrepMatchMode, GrepParams } from "./types.js";

export type GrepQueryShape = "long_text" | "identifier" | "qualified_symbol" | "natural_language";
export type RelationIntent = "caller" | "callee" | "reference" | "test" | "import" | "registration";

export interface QueryPlan {
	readonly query: string;
	readonly paths: readonly string[];
	readonly match: GrepMatchMode;
	readonly glob?: string;
	readonly shape: GrepQueryShape;
	readonly relationIntents: readonly RelationIntent[];
	readonly targetTerms: readonly string[];
	readonly targetQuery: string;
	readonly regex?: RegExp;
}

const IDENTIFIER = /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u;
const QUALIFIED_SYMBOL = /^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*(?:(?:\.|::|#)[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)+$/u;
const NATURAL_LANGUAGE = /^[\p{L}\p{N}_$'’ -]+[?？]?$/u;
const ERROR_LANGUAGE = /\b(?:error|exception|failed|failure|panic|traceback|cannot|unable|invalid|unexpected)\b/iu;

const RELATION_PATTERNS: Readonly<Record<RelationIntent, readonly RegExp[]>> = {
	caller: [/(?:^|\b)callers?\s+(?:of|for)\b/iu, /\bcalled\s+by\b/iu, /\bwhat\s+calls\b/iu],
	callee: [/(?:^|\b)callees?\s+(?:of|for)\b/iu, /\bcalls?\s+(?:from|by)\b/iu, /\bwhat\s+does\b.+\bcall\b/iu],
	reference: [/(?:^|\b)(?:references?|usages?)\s+(?:to|of|for)\b/iu, /\bwhere\b.+\b(?:referenced|used)\b/iu],
	test: [/(?:^|\b)(?:tests?|specs?)\s+(?:for|of)\b/iu, /\bwhere\b.+\b(?:tested|specified)\b/iu, /\S+\s+(?:tests?|specs?)$/iu],
	import: [/(?:^|\b)imports?\s+(?:of|for)\b/iu, /\bwhere\b.+\b(?:is|are)\s+imported\b/iu],
	registration: [/(?:^|\b)registrations?\s+(?:of|for)\b/iu, /\bwhere\b.+\b(?:is|are)\s+registered\b/iu],
};

const RELATION_WORDS = new Set([
	"caller", "callers", "called", "callee", "callees", "calls", "call",
	"reference", "references", "referenced", "usage", "usages", "used",
	"test", "tests", "tested", "spec", "specs", "specified",
	"import", "imports", "imported", "registration", "registrations", "registered",
	"where", "what", "does", "is", "are", "by", "of", "for", "from", "to",
]);

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
	const match = params.match ?? "auto";
	if (match !== "auto" && match !== "literal" && match !== "regex") {
		return fail("INVALID_OPERATION", "match must be auto, literal, or regex.", { path: paths[0] ?? "." });
	}
	if (match !== "auto" && /[\r\n]/u.test(params.query)) {
		return fail("INVALID_OPERATION", "literal and regex queries must not contain CR or LF.", { path: paths[0] ?? "." });
	}
	if (params.glob !== undefined && (typeof params.glob !== "string" || params.glob.length === 0 || params.glob.includes("\0"))) {
		return fail("INVALID_PATH", "glob must be a non-empty string without NUL bytes.", { path: paths[0] ?? "." });
	}
	const regex = match === "regex" ? compileLineRegex(params.query, paths[0] ?? ".") : undefined;
	if (regex !== undefined && "status" in regex) return regex;
	const relationIntents = detectRelationIntents(params.query);
	const targetTerms = extractTargetTerms(params.query, relationIntents.length > 0);
	return {
		query: params.query,
		paths: [...paths],
		match,
		...(params.glob === undefined ? {} : { glob: params.glob }),
		shape: classifyQueryShape(params.query),
		relationIntents,
		targetTerms,
		targetQuery: targetTerms.join(" "),
		...(regex === undefined ? {} : { regex }),
	};
}

export function compileLineRegex(query: string, path = "."): RegExp | ReturnType<typeof fail> {
	try {
		return new RegExp(query, "u");
	} catch (error) {
		return fail("INVALID_REGEX", error instanceof Error ? error.message : "Invalid regular expression.", { path });
	}
}

export function classifyQueryShape(query: string): GrepQueryShape {
	const normalized = query.trim();
	if (QUALIFIED_SYMBOL.test(normalized)) return "qualified_symbol";
	if (IDENTIFIER.test(normalized)) return "identifier";
	const terms = lexicalTerms(normalized);
	if (terms.length >= 2 && NATURAL_LANGUAGE.test(normalized) && !isErrorLikeQuery(normalized)) return "natural_language";
	return "long_text";
}

export function isErrorLikeQuery(query: string): boolean {
	return ERROR_LANGUAGE.test(query);
}

export function detectRelationIntents(query: string): RelationIntent[] {
	const intents: RelationIntent[] = [];
	for (const intent of ["caller", "callee", "reference", "test", "import", "registration"] as const) {
		if (RELATION_PATTERNS[intent].some((pattern) => pattern.test(query))) intents.push(intent);
	}
	return intents;
}

function extractTargetTerms(query: string, hasRelationIntent: boolean): string[] {
	const terms = lexicalTerms(query);
	if (!hasRelationIntent) return terms;
	return terms.filter((term) => !RELATION_WORDS.has(term.toLocaleLowerCase()));
}

function lexicalTerms(value: string): string[] {
	return value.match(/[$_\p{L}\p{N}]+(?:[.:#][$_\p{L}\p{N}]+)*/gu) ?? [];
}
