import { fail, type ToolOutcome } from "../shared/result.js";

export type FindTermType = "fuzzy" | "exact" | "boundary" | "prefix" | "suffix" | "equal";

export interface FindQueryTerm {
	readonly text: string;
	readonly type: FindTermType;
	readonly inverse: boolean;
	readonly caseSensitive: boolean;
}

export interface FindQueryPlan {
	readonly query: string;
	/** 外层为 AND，内层为 OR。 */
	readonly groups: readonly (readonly FindQueryTerm[])[];
}

interface QueryToken {
	readonly value: string;
	readonly escaped: readonly boolean[];
}

/** 解析 fzf extended-search query；普通 term 为 fuzzy，空格 AND，独立 | 连接 OR。 */
export function createFindQueryPlan(input: string): ToolOutcome<FindQueryPlan> {
	if (input.trim().length === 0) return fail("INVALID_OPERATION", "query must not be empty.");
	if (input.includes("\0") || /[\r\n]/u.test(input)) {
		return fail("INVALID_OPERATION", "query must not contain NUL, CR, or LF.");
	}
	const tokens = tokenize(input.trim());
	const groups: FindQueryTerm[][] = [];
	let alternative = false;
	for (const token of tokens) {
		if (isOrToken(token)) {
			if (alternative || groups.length === 0) {
				return fail("INVALID_OPERATION", "query contains a misplaced OR operator.");
			}
			alternative = true;
			continue;
		}
		const term = parseTerm(token);
		if (term === undefined) return fail("INVALID_OPERATION", "query contains an empty search term.");
		if (alternative) {
			groups[groups.length - 1]?.push(term);
			alternative = false;
		} else {
			groups.push([term]);
		}
	}
	if (alternative) return fail("INVALID_OPERATION", "query must not end with an OR operator.");
	if (groups.length === 0) return fail("INVALID_OPERATION", "query must contain a search term.");
	return { query: input.trim(), groups };
}

function tokenize(input: string): QueryToken[] {
	const tokens: Array<{ value: string[]; escaped: boolean[] }> = [];
	let current = { value: [] as string[], escaped: [] as boolean[] };
	const flush = () => {
		if (current.value.length > 0) tokens.push(current);
		current = { value: [], escaped: [] };
	};
	const chars = Array.from(input);
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index];
		if (char === "\\") {
			const next = chars[index + 1];
			if (next === undefined) {
				current.value.push(char);
				current.escaped.push(false);
			} else {
				current.value.push(next);
				current.escaped.push(true);
				index += 1;
			}
			continue;
		}
		if (char !== undefined && /\s/u.test(char)) {
			flush();
			continue;
		}
		if (char !== undefined) {
			current.value.push(char);
			current.escaped.push(false);
		}
	}
	flush();
	return tokens.map((token) => ({ value: token.value.join(""), escaped: token.escaped }));
}

function isOrToken(token: QueryToken): boolean {
	return token.value === "|" && token.escaped[0] === false;
}

function parseTerm(input: QueryToken): FindQueryTerm | undefined {
	let token = input;
	let inverse = false;
	if (hasLeadingOperator(token, "!")) {
		inverse = true;
		token = sliceToken(token, 1);
	}
	if (token.value.length === 0) return undefined;

	let type: FindTermType = "fuzzy";
	if (hasLeadingOperator(token, "^") && hasTrailingOperator(token, "$") && token.value.length >= 2) {
		type = "equal";
		token = sliceToken(token, 1, -1);
	} else if (hasLeadingOperator(token, "^")) {
		type = "prefix";
		token = sliceToken(token, 1);
	} else if (hasTrailingOperator(token, "$")) {
		type = "suffix";
		token = sliceToken(token, 0, -1);
	} else if (!inverse && hasLeadingOperator(token, "'") && hasTrailingOperator(token, "'") && token.value.length >= 2) {
		type = "boundary";
		token = sliceToken(token, 1, -1);
	} else if (hasLeadingOperator(token, "'")) {
		// 与 fzf 一致：!'term 显式请求 inverse fuzzy；正向 'term 为 exact substring。
		type = inverse ? "fuzzy" : "exact";
		token = sliceToken(token, 1);
	} else if (inverse) {
		type = "exact";
	}
	if (token.value.length === 0) return undefined;
	return {
		text: token.value,
		type,
		inverse,
		caseSensitive: hasUppercase(token.value),
	};
}

function hasLeadingOperator(token: QueryToken, operator: string): boolean {
	return token.value.startsWith(operator) && token.escaped[0] === false;
}

function hasTrailingOperator(token: QueryToken, operator: string): boolean {
	const index = Array.from(token.value).length - 1;
	return index >= 0 && Array.from(token.value)[index] === operator && token.escaped[index] === false;
}

function sliceToken(token: QueryToken, start: number, end?: number): QueryToken {
	const chars = Array.from(token.value);
	return {
		value: chars.slice(start, end).join(""),
		escaped: token.escaped.slice(start, end),
	};
}

function hasUppercase(value: string): boolean {
	return value !== value.toLocaleLowerCase();
}
