export interface SearchScopeCount {
	readonly path: string;
	readonly count: number;
}

export interface SearchNavigation {
	readonly narrow?: readonly SearchScopeCount[];
	/** 已知未完成的范围，不代表完整的未搜索清单。 */
	readonly incomplete?: readonly string[];
}

export const SEARCH_HINT_LIMIT = 3;

/** 只统计已发现的命中，不为导航额外遍历或读取正文。 */
export class SearchScopeCounts {
	private readonly counts = new Map<string, number>();

	add(scope: string, path: string, allowFiles = false): void {
		const prefix = scope === "." ? "" : scope.endsWith("/") ? scope : `${scope}/`;
		if (!path.startsWith(prefix)) return;
		const relative = path.slice(prefix.length);
		const slash = relative.indexOf("/");
		if (slash < 0 && !allowFiles) return;
		const target = slash < 0 ? path : `${prefix}${relative.slice(0, slash)}`;
		if (target === scope || target.length === 0) return;
		this.counts.set(target, (this.counts.get(target) ?? 0) + 1);
	}

	result(): SearchScopeCount[] {
		return [...this.counts].map(([path, count]) => ({ path, count }))
			.sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.slice(0, SEARCH_HINT_LIMIT);
	}
}

export function recordIncomplete(paths: string[], path: string): void {
	if (paths.length < SEARCH_HINT_LIMIT && !paths.includes(path)) paths.push(path);
}

/** 数量仅指已扫描候选。提示不是穷举结果，也不自动扩大搜索范围。 */
export function formatSearchNavigation(navigation: SearchNavigation | undefined): string[] {
	const lines: string[] = [];
	if (navigation?.incomplete !== undefined && navigation.incomplete.length > 0) {
		lines.push(`incomplete: ${JSON.stringify(navigation.incomplete)}`);
	}
	if (navigation?.narrow !== undefined && navigation.narrow.length > 0) {
		lines.push(`next: narrow path to ${navigation.narrow.map((item) => `${JSON.stringify(item.path)} (${item.count} candidates)`).join(", ")}`);
	} else if (navigation?.incomplete !== undefined && navigation.incomplete.length > 0) {
		lines.push(`next: search incomplete paths separately with a narrower query/glob`);
	} else {
		lines.push("next: narrow query/path/glob");
	}
	return lines;
}
