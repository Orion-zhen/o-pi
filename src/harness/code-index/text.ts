const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;
const DECLARATION_CODE_POINT_LIMIT = 240;
const EMPTY_TEXT_TOKENS: readonly string[] = [];

export function compactDeclaration(value: string): string {
	const compact = value.replace(/\s+/gu, " ").trim();
	const points = [...compact];
	return points.length <= DECLARATION_CODE_POINT_LIMIT
		? compact
		: `${points.slice(0, DECLARATION_CODE_POINT_LIMIT - 3).join("")}...`;
}

export function tokenizeText(value: string): Map<string, number> {
	const result = new Map<string, number>();
	visitTokenOccurrences(value, (raw) => {
		const token = raw.toLocaleLowerCase();
		result.set(token, (result.get(token) ?? 0) + 1);
	});
	return result;
}

export function splitTokens(value: string): string[] {
	const tokens = new Set<string>();
	visitTokenOccurrences(value, (token) => { tokens.add(token); });
	return [...tokens];
}

/** 只匹配已归一化的查询词，不为正文中的无关词项分配计数 Map。 */
export function createTextTokenMatcher(queryTokens: readonly string[]): (value: string) => readonly string[] {
	const ordered = [...new Set(queryTokens)];
	const expected = new Set(ordered);
	return (value) => {
		if (expected.size === 0) return EMPTY_TEXT_TOKENS;
		let matched: Set<string> | undefined;
		visitTokenOccurrences(value, (raw) => {
			const normalized = raw.toLocaleLowerCase();
			if (expected.has(normalized)) (matched ??= new Set()).add(normalized);
			return (matched?.size ?? 0) < expected.size;
		});
		const result = matched;
		return result === undefined ? EMPTY_TEXT_TOKENS : ordered.filter((token) => result.has(token));
	};
}

function visitTokenOccurrences(value: string, visit: (token: string) => boolean | void): void {
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0];
		if (visit(raw) === false) return;
		// 小写标识符和数字无法再拆出新词，跳过常见情况的额外正则扫描。
		if (/^[a-z0-9]+$/u.test(raw)) continue;
		const parts = raw
			.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
			.split(/[^A-Za-z0-9]+/u)
			.filter(Boolean);
		for (const part of parts) if (visit(part) === false) return;
	}
}
