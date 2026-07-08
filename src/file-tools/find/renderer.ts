import { createPathIndex, sortedChildren, type PathIndexNode } from "./path-index.js";
import { countTextTokensSync } from "../../token-counter.js";
import type { FindCollapsedGroup, FindDetails, FindMatch } from "../types.js";

const NARROW_RESULT_LIMIT = 20;
const TOP_MATCH_LIMIT = 12;

export interface RenderFindInput {
	query: string;
	path: string;
	strategy: FindDetails["strategy"];
	totalMatches: number;
	totalFiles: number;
	totalDirectories: number;
	scannedEntries: number;
	matches: FindMatch[];
	ignoredCount: number;
	skippedCount: number;
	truncated: boolean;
	outputTokenBudget: number;
	suggestions?: FindMatch[];
	missingPrefix?: string;
	nearbyDirectory?: string;
}

/** 渲染 find 成功结果；预算按完整输出行控制，避免截断路径字符串。 */
export function renderFindResults(input: RenderFindInput): { content: string; details: FindDetails } {
	const tokenBudget = input.outputTokenBudget;
	const collapsedGroups = collapseMatches(input.matches);
	const details = buildDetails(input, collapsedGroups);
	if (input.totalMatches === 0) return { content: renderNoMatches(input, tokenBudget), details };

	const header = formatHeader(input.totalMatches, input.totalFiles, input.totalDirectories);
	const narrowLines = [header, "", ...input.matches.map(formatMatchPath)];
	if (input.matches.length <= NARROW_RESULT_LIMIT && fitsBudget(narrowLines, tokenBudget)) {
		return { content: narrowLines.filter((line, index) => index !== 1 || input.matches.length > 0).join("\n"), details };
	}

	const selected = selectConcreteMatches(input.matches);
	const selectedPaths = new Set(selected.map((match) => match.path));
	const groups = collapseMatches(input.matches.filter((match) => !selectedPaths.has(match.path)));
	const lines = [header, "", "Top matches:", ...selected.map(formatMatchPath)];
	if (groups.length > 0) lines.push("", "Other matches:", ...groups.map(formatGroup));
	if (input.truncated) lines.push("", `Scanned ${input.scannedEntries} entries; results truncated.`);
	const content = takeBudgetedLines(lines, tokenBudget).join("\n");
	return {
		content,
		details: {
			...details,
			collapsedGroups: groups,
			truncated: input.truncated || selected.length + countCollapsed(groups) < input.matches.length,
		},
	};
}

function renderNoMatches(input: RenderFindInput, tokenBudget: number): string {
	const lines = input.ignoredCount > 0
		? ["No visible matches.", `${input.ignoredCount} matching entries were excluded by ignore rules.`]
		: [`No matches for "${input.query}"`];
	if (input.missingPrefix !== undefined) lines.push("", `Missing prefix: ${withDirectorySlash(input.missingPrefix)}`);
	if (input.nearbyDirectory !== undefined) lines.push(`Nearby directory: ${withDirectorySlash(input.nearbyDirectory)}`);
	if (input.suggestions !== undefined && input.suggestions.length > 0) {
		lines.push("", "Nearby:", ...input.suggestions.map(formatMatchPath));
	}
	return takeBudgetedLines(lines, tokenBudget).join("\n");
}

function buildDetails(input: RenderFindInput, collapsedGroups: FindCollapsedGroup[]): FindDetails {
	const matches = input.matches.map(({ path, kind }) => ({ path, kind }));
	return {
		query: input.query,
		path: input.path,
		strategy: input.strategy,
		totalMatches: input.totalMatches,
		returnedMatches: matches.length,
		scannedEntries: input.scannedEntries,
		matches,
		collapsedGroups,
		ignoredCount: input.ignoredCount,
		skippedCount: input.skippedCount,
		truncated: input.truncated,
		...(input.suggestions !== undefined && input.suggestions.length > 0 ? { suggestions: input.suggestions } : {}),
		...(input.missingPrefix !== undefined ? { missingPrefix: input.missingPrefix } : {}),
		...(input.nearbyDirectory !== undefined ? { nearbyDirectory: input.nearbyDirectory } : {}),
	};
}

function formatHeader(totalMatches: number, files: number, directories: number): string {
	const parts = [`${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`];
	if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
	if (directories > 0) parts.push(`${directories} ${directories === 1 ? "directory" : "directories"}`);
	return parts.join(" · ");
}

function selectConcreteMatches(matches: FindMatch[]): FindMatch[] {
	const selected: FindMatch[] = [];
	const selectedPaths = new Set<string>();
	const perTopDirectory = new Map<string, number>();
	for (const match of matches) {
		if (selected.length >= Math.min(TOP_MATCH_LIMIT, matches.length)) break;
		const group = topDirectory(match.path);
		const count = perTopDirectory.get(group) ?? 0;
		if (count >= 4 && hasUnrepresentedTopDirectory(matches, selectedPaths, perTopDirectory)) continue;
		selected.push(match);
		selectedPaths.add(match.path);
		perTopDirectory.set(group, count + 1);
	}
	for (const match of matches) {
		if (selected.length >= Math.min(TOP_MATCH_LIMIT, matches.length)) break;
		if (selectedPaths.has(match.path)) continue;
		selected.push(match);
		selectedPaths.add(match.path);
	}
	return selected;
}

function hasUnrepresentedTopDirectory(matches: FindMatch[], selectedPaths: Set<string>, counts: Map<string, number>): boolean {
	for (const match of matches) {
		if (selectedPaths.has(match.path)) continue;
		if (!counts.has(topDirectory(match.path))) return true;
	}
	return false;
}

function collapseMatches(matches: FindMatch[]): FindCollapsedGroup[] {
	if (matches.length === 0) return [];
	const index = createPathIndex(matches);
	const groups: FindCollapsedGroup[] = [];
	for (const child of sortedChildren(index)) collectGroup(child, groups);
	return groups;
}

function collectGroup(node: PathIndexNode, groups: FindCollapsedGroup[]): void {
	const compressed = compressSingleChildDirectory(node);
	if (compressed.entryKind !== undefined && compressed.children.size === 0) return;
	if (compressed.path !== "." && compressed.descendantFileCount + compressed.descendantDirectoryCount > 0) {
		groups.push({
			path: compressed.path,
			files: compressed.descendantFileCount,
			directories: compressed.descendantDirectoryCount,
		});
		return;
	}
	for (const child of sortedChildren(compressed)) collectGroup(child, groups);
}

function compressSingleChildDirectory(node: PathIndexNode): PathIndexNode {
	let current = node;
	while (current.entryKind === undefined && current.children.size === 1) {
		const only = sortedChildren(current)[0];
		if (only === undefined || only.entryKind !== undefined) break;
		current = only;
	}
	return current;
}

function countCollapsed(groups: FindCollapsedGroup[]): number {
	return groups.reduce((sum, group) => sum + group.files + group.directories, 0);
}

function formatMatchPath(match: FindMatch): string {
	return match.kind === "directory" ? withDirectorySlash(match.path) : match.path;
}

function formatGroup(group: FindCollapsedGroup): string {
	const counts = [];
	if (group.files > 0) counts.push(`${group.files} ${group.files === 1 ? "file" : "files"}`);
	if (group.directories > 0) counts.push(`${group.directories} ${group.directories === 1 ? "directory" : "directories"}`);
	return `${withDirectorySlash(group.path)}** (${counts.join(", ")})`;
}

function withDirectorySlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function topDirectory(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function fitsBudget(lines: string[], tokenBudget: number): boolean {
	return tokenCount(lines.join("\n")) <= tokenBudget;
}

function takeBudgetedLines(lines: string[], tokenBudget: number): string[] {
	const result: string[] = [];
	for (const line of lines) {
		const next = [...result, line].join("\n");
		if (tokenCount(next) > tokenBudget && result.length > 0) break;
		result.push(line);
	}
	return result;
}

function tokenCount(text: string): number {
	return countTextTokensSync(text).tokens;
}
