import type { WebSearchParams } from "../core/types.ts";
import type { NormalizedSearchParams, SearchDateQuery, SearchProviderFailure } from "./types.ts";

interface SearchDomainFilters {
	includeDomains: readonly string[];
	excludeDomains: readonly string[];
}

type DateOperators = Partial<Record<"after" | "before" | "recent", string>>;

export function normalizeSearchParams(params: WebSearchParams, defaultLimit: number, filters: SearchDomainFilters): { status: "success"; params: NormalizedSearchParams } | SearchProviderFailure {
	const query = params.query.trim();
	const included = [...filters.includeDomains];
	const excluded = [...filters.excludeDomains];
	const dates: DateOperators = {};
	const words: string[] = [];
	const passthroughWords: string[] = [];
	for (const word of queryWords(query)) {
		const colon = word.indexOf(":");
		const operator = colon < 0 ? "" : word.slice(0, colon).toLowerCase();
		const value = word.slice(colon + 1);
		if ((operator === "site" || operator === "-site") && value.length > 0) {
			const domain = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
			(operator === "site" ? included : excluded).push(domain);
			continue;
		}
		passthroughWords.push(word);
		if (operator === "after" || operator === "before" || operator === "recent") {
			if (dates[operator] !== undefined) return invalidQuery(`Duplicate ${operator}: filter.`);
			dates[operator] = value;
			continue;
		}
		words.push(word);
	}
	const dateQuery = parseDateFilters(dates);
	if (dateQuery.status === "failed") return dateQuery;
	const textQuery = words.join(" ");
	if (dateQuery.dates !== undefined && !textQuery) return invalidQuery("Date filters require search terms.");
	const includeDomains = normalizeDomains(included);
	const excludeDomains = normalizeDomains(excluded);
	if (includeDomains.some((domain) => excludeDomains.includes(domain))) return invalidQuery("site: and -site: domains must not overlap.");
	return { status: "success", params: {
		query,
		limit: params.limit ?? defaultLimit,
		textQuery: textQuery || query,
		passthroughQuery: passthroughWords.join(" "),
		dates: dateQuery.dates,
		includeDomains,
		excludeDomains,
	} };
}

/** 重建域名操作符，多个包含域名使用 OR 语义。 */
export function filteredLexicalQuery(textQuery: string, { includeDomains, excludeDomains }: SearchDomainFilters): string {
	const includeClause = includeDomains.length > 1
		? `(${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
		: includeDomains[0] === undefined ? undefined : `site:${includeDomains[0]}`;
	return [
		textQuery,
		includeClause,
		...excludeDomains.map((domain) => `-site:${domain}`),
	].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

/** 相对时间在提供方执行时解析，不把变化的时间戳写入并发请求指纹。 */
export function resolveDateBounds(dates: SearchDateQuery | undefined, now: number): { after: string | undefined; before: string | undefined } {
	if (dates === undefined) return { after: undefined, before: undefined };
	return dates.kind === "recent"
		? { after: new Date(now - dates.days * 86_400_000).toISOString(), before: undefined }
		: {
			after: dates.after === undefined ? undefined : `${dates.after}T00:00:00.000Z`,
			before: dates.before === undefined ? undefined : `${dates.before}T00:00:00.000Z`,
		};
}

/** 按引号外未转义的空白分词，保留每个词的原始内容。 */
function* queryWords(query: string): Generator<string> {
	let start = 0;
	let quoted = false;
	for (let index = 0; index < query.length; index++) {
		const character = query.charAt(index);
		if (character === "\\") {
			index++;
		} else if (character === '"') {
			quoted = !quoted;
		} else if (!quoted && /\s/u.test(character)) {
			if (start < index) yield query.slice(start, index);
			start = index + 1;
		}
	}
	if (start < query.length) yield query.slice(start);
}

function parseDateFilters({ after, before, recent }: DateOperators): { status: "success"; dates: SearchDateQuery | undefined } | SearchProviderFailure {
	if (recent !== undefined) {
		if (after !== undefined || before !== undefined) return invalidQuery("recent: cannot be combined with after: or before:.");
		if (!/^[1-9]\d*d$/iu.test(recent)) return invalidQuery("recent: must be 1-3650d.");
		const days = Number(recent.slice(0, -1));
		if (days > 3650) return invalidQuery("recent: must be 1-3650d.");
		return { status: "success", dates: { kind: "recent", days } };
	}
	if ((after !== undefined && !validDate(after)) || (before !== undefined && !validDate(before))) {
		return invalidQuery("after: and before: require valid YYYY-MM-DD dates.");
	}
	if (after !== undefined && before !== undefined && after > before) return invalidQuery("after: must not be later than before:.");
	if (after !== undefined) return { status: "success", dates: { kind: "range", after, ...(before === undefined ? {} : { before }) } };
	if (before !== undefined) return { status: "success", dates: { kind: "range", before } };
	return { status: "success", dates: undefined };
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalidQuery(message: string): SearchProviderFailure {
	return { status: "failed", error: { code: "INVALID_ARGUMENT", message } };
}

export function normalizeDomains(values: readonly string[]): string[] {
	const domains = values.flatMap((value) => {
		const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^\*\./u, "").split("/")[0];
		return trimmed && /^[a-z0-9.-]+$/u.test(trimmed) ? [trimmed.replace(/\.$/u, "")] : [];
	});
	return [...new Set(domains)].sort();
}
