import { createPathIndex, sortedChildren, type PathIndexNode } from "./path-index.js";
import { countTextTokensSync } from "../../token-counter.js";
import type { FindCollapsedGroup, FindDetails, FindMatch, FindNearbyResult, FindScopeError, RepoMapRelatedResult } from "../types.js";

const NARROW_RESULT_LIMIT = 20;
const TOP_MATCH_LIMIT = 12;

export interface RenderFindInput {
	query: string;
	path: string;
	paths?: string[];
	scopeErrors?: FindScopeError[];
	strategy: FindDetails["strategy"];
	totalMatches: number;
	scannedEntries: number;
	matches: FindMatch[];
	ignoredCount: number;
	skippedCount: number;
	scanTruncated: boolean;
	resultLimited: boolean;
	outputTokenBudget: number;
	related?: RepoMapRelatedResult[];
	nearby?: FindNearbyResult[];
	missingPrefix?: string;
	nearbyDirectory?: string;
	candidateSources?: Record<string, string[]>;
}

/** 渲染 find 成功结果；预算按完整输出行控制，避免截断路径字符串。 */
export function renderFindResults(input: RenderFindInput): { content: string; details: FindDetails } {
	const tokenBudget = input.outputTokenBudget;
	const collapsedGroups = collapseMatches(input.matches);
	if (input.totalMatches === 0) {
		const packed = packLines(withScopeWarning(renderNoMatches(input), input), input, tokenBudget);
		const nearby = appendNearby(packed.content, input.nearby, tokenBudget);
		const rendered = appendRelated(nearby.content, input.related, tokenBudget);
		const hasNavigation = input.missingPrefix !== undefined
			|| input.nearbyDirectory !== undefined
			|| nearby.nearby.length > 0
			|| rendered.related.length > 0;
		const content = hasNavigation ? rendered.content : appendNoMatchDiagnostic(rendered.content, input, tokenBudget);
		return {
			content,
				details: buildDetails(
				{ ...input, nearby: nearby.nearby },
				collapsedGroups,
				rendered.related,
				packed.outputTruncated,
			),
		};
	}

	if (input.matches.length <= NARROW_RESULT_LIMIT) {
		const formatted = formatConcreteMatches(input.matches);
		const packed = packLines(withScopeWarning(formatted, input), input, tokenBudget);
		const payloadLineCount = Math.max(0, packed.payloadLineCount - (scopeWarning(input) === undefined ? 0 : 1));
		const visibleMatches = input.matches.slice(0, concreteMatchCount(formatted, input.matches.length, payloadLineCount));
		const rendered = appendRelated(packed.content, input.related, tokenBudget);
		return {
			content: rendered.content,
			details: buildDetails(input, collapsedGroups, rendered.related, packed.outputTruncated, visibleMatches, []),
		};
	}

	const selected = selectConcreteMatches(input.matches);
	const selectedPaths = new Set(selected.map((match) => match.path));
	const groups = collapseMatches(input.matches.filter((match) => !selectedPaths.has(match.path)));
	const formattedSelected = formatConcreteMatches(selected);
	const lines = withScopeWarning(["top:", ...formattedSelected], input);
	if (groups.length > 0) lines.push("other:", ...groups.map(formatGroup));
	const packed = packLines(lines, input, tokenBudget);
	let remaining = packed.payloadLineCount;
	if (scopeWarning(input) !== undefined && remaining > 0) remaining -= 1;
	if (remaining > 0) remaining -= 1;
	const selectedLineCount = Math.min(formattedSelected.length, remaining);
	const visibleMatches = selected.slice(0, concreteMatchCount(formattedSelected, selected.length, selectedLineCount));
	remaining -= selectedLineCount;
	if (groups.length > 0 && remaining > 0) remaining -= 1;
	const visibleGroups = groups.slice(0, Math.max(0, remaining));
	return {
		content: packed.content,
		details: {
			...buildDetails(input, collapsedGroups, [], packed.outputTruncated, visibleMatches, visibleGroups),
			collapsedGroups: groups,
		},
	};
}

function scopeWarning(input: RenderFindInput): string | undefined {
	const errors = input.scopeErrors;
	if (errors === undefined || errors.length === 0) return undefined;
	const summary = errors.map(({ path, error }) => `${path}:${error.code}`).join(",");
	return `partial; scope_errors=${summary}`;
}

function withScopeWarning(lines: string[], input: RenderFindInput): string[] {
	const warning = scopeWarning(input);
	return warning === undefined ? lines : [warning, ...lines];
}

function renderNoMatches(input: RenderFindInput): string[] {
	const lines = input.ignoredCount > 0
		? [`none visible; ignored=${input.ignoredCount}`]
		: ["none"];
	if (input.missingPrefix !== undefined) lines.push(`missing prefix: ${withDirectorySlash(input.missingPrefix)}`);
	if (input.nearbyDirectory !== undefined) lines.push(`near dir: ${withDirectorySlash(input.nearbyDirectory)}`);
	return lines;
}

function appendNearby(
	content: string,
	candidates: FindNearbyResult[] | undefined,
	tokenBudget: number,
): { content: string; nearby: FindNearbyResult[] } {
	if (candidates === undefined || candidates.length === 0) return { content, nearby: [] };
	const nearby: FindNearbyResult[] = [];
	let output = content;
	for (const candidate of candidates) {
		const nextNearby = [...nearby, candidate];
		const next = `${content}\n<nearby nonmatch>\n${nextNearby.map((item) => `${formatMatchPath(item)} [${item.reason}]`).join("\n")}\n</nearby>`;
		if (tokenCount(next) > tokenBudget) break;
		nearby.push(candidate);
		output = next;
	}
	return { content: output, nearby };
}

function appendNoMatchDiagnostic(content: string, input: RenderFindInput, tokenBudget: number): string {
	const lines = [
		`searched=${input.scannedEntries}; ignored=${input.ignoredCount}; skipped=${input.skippedCount}`,
		"next: broaden query or path",
	];
	let output = content;
	for (const line of lines) {
		const next = `${output}\n${line}`;
		if (tokenCount(next) > tokenBudget) break;
		output = next;
	}
	return output;
}

function buildDetails(
	input: RenderFindInput,
	collapsedGroups: FindCollapsedGroup[],
	related: RepoMapRelatedResult[],
	outputTruncated: boolean,
	displayedMatches: FindMatch[] = input.matches,
	displayedCollapsedGroups: FindCollapsedGroup[] = collapsedGroups,
): FindDetails {
	const matches = input.matches.map(({ path, kind }) => ({ path, kind }));
	const visiblePaths = new Set(matches.map((match) => match.path));
	const candidateSources = input.candidateSources === undefined
		? undefined
		: Object.fromEntries(Object.entries(input.candidateSources).filter(([candidatePath]) => visiblePaths.has(candidatePath)));
	return {
		query: input.query,
		path: input.path,
		paths: input.paths ?? [input.path],
		...(input.scopeErrors !== undefined && input.scopeErrors.length > 0 ? { scope_errors: input.scopeErrors } : {}),
		strategy: input.strategy,
		totalMatches: input.totalMatches,
		returnedMatches: matches.length,
		scannedEntries: input.scannedEntries,
		matches,
		collapsedGroups,
		displayedMatches: displayedMatches.map(({ path, kind }) => ({ path, kind })),
		displayedCollapsedGroups,
		ignoredCount: input.ignoredCount,
		skippedCount: input.skippedCount,
		scanTruncated: input.scanTruncated,
		resultLimited: input.resultLimited,
		outputTruncated,
		...(related.length > 0 ? { related } : {}),
		...(input.nearby !== undefined && input.nearby.length > 0 ? { nearby: input.nearby } : {}),
		...(input.missingPrefix !== undefined ? { missingPrefix: input.missingPrefix } : {}),
		...(input.nearbyDirectory !== undefined ? { nearbyDirectory: input.nearbyDirectory } : {}),
		...(candidateSources !== undefined ? { candidateSources } : {}),
	};
}

function concreteMatchCount(formatted: readonly string[], matchCount: number, visibleLines: number): number {
	const grouped = formatted.length === matchCount + 1;
	return Math.max(0, Math.min(matchCount, visibleLines - (grouped ? 1 : 0)));
}

function appendRelated(
	content: string,
	candidates: RepoMapRelatedResult[] | undefined,
	tokenBudget: number,
): { content: string; related: RepoMapRelatedResult[] } {
	if (candidates === undefined || candidates.length === 0) return { content, related: [] };
	const header = "<related repo-map nonmatch>";
	const related: RepoMapRelatedResult[] = [];
	let output = content;
	for (const candidate of candidates) {
		const nextRelated = [...related, candidate];
		const next = `${content}\n${header}\n${nextRelated.map((item) => `${item.path} [${item.relations.join(",")}]`).join("\n")}\n</related>`;
		if (tokenCount(next) > tokenBudget) break;
		related.push(candidate);
		output = next;
	}
	if (related.length === 0) return { content, related };
	return { content: output, related };
}

function selectConcreteMatches(matches: FindMatch[]): FindMatch[] {
	return matches.slice(0, TOP_MATCH_LIMIT);
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

function formatMatchPath(match: FindMatch): string {
	return match.kind === "directory" ? withDirectorySlash(match.path) : match.path;
}

function formatGroup(group: FindCollapsedGroup): string {
	const counts = [];
	if (group.files > 0) counts.push(`${group.files} ${group.files === 1 ? "file" : "files"}`);
	if (group.directories > 0) counts.push(`${group.directories} ${group.directories === 1 ? "directory" : "directories"}`);
	return `${withDirectorySlash(group.path)}** (${counts.join(", ")})`;
}

/** 共享所有具体结果的目录前缀；仅在确实减少 token 时启用。 */
function formatConcreteMatches(matches: FindMatch[]): string[] {
	const direct = matches.map(formatMatchPath);
	if (matches.length < 2 || matches.some((match) => isAbsoluteDisplayPath(match.path))) return direct;
	const prefix = commonDirectoryPrefix(matches);
	if (prefix.length === 0) return direct;
	const grouped = [
		`in ${prefix.join("/")}/`,
		...matches.map((match) => `  ${formatRelativeMatch(match, prefix.length)}`),
	];
	return tokenCount(grouped.join("\n")) < tokenCount(direct.join("\n")) ? grouped : direct;
}

function commonDirectoryPrefix(matches: FindMatch[]): string[] {
	const directories = matches.map((match) => match.path.split("/").filter(Boolean).slice(0, -1));
	const first = directories[0] ?? [];
	let length = first.length;
	for (const segments of directories.slice(1)) {
		length = Math.min(length, segments.length);
		for (let index = 0; index < length; index += 1) {
			if (segments[index] !== first[index]) {
				length = index;
				break;
			}
		}
	}
	return first.slice(0, length);
}

function formatRelativeMatch(match: FindMatch, prefixLength: number): string {
	const relative = match.path.split("/").filter(Boolean).slice(prefixLength).join("/");
	return match.kind === "directory" ? withDirectorySlash(relative) : relative;
}

function isAbsoluteDisplayPath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:\//u.test(value);
}

function withDirectorySlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function packLines(
	lines: string[],
	input: Pick<RenderFindInput, "totalMatches" | "matches" | "scanTruncated" | "resultLimited">,
	tokenBudget: number,
): { content: string; outputTruncated: boolean; payloadLineCount: number } {
	const firstStatus = formatIncompleteStatus(input, false);
	const first = takeBudgetedLines(firstStatus === undefined ? lines : [firstStatus, ...lines], tokenBudget);
	if (first.length === lines.length + (firstStatus === undefined ? 0 : 1)) {
		return { content: first.join("\n"), outputTruncated: false, payloadLineCount: lines.length };
	}
	const status = formatIncompleteStatus(input, true) ?? "output truncated";
	const packed = takeBudgetedLines([status, ...lines], tokenBudget);
	return { content: packed.join("\n"), outputTruncated: true, payloadLineCount: Math.max(0, packed.length - 1) };
}

function formatIncompleteStatus(
	input: Pick<RenderFindInput, "totalMatches" | "matches" | "scanTruncated" | "resultLimited">,
	outputTruncated: boolean,
): string | undefined {
	const flags = [
		input.scanTruncated ? "scan" : undefined,
		input.resultLimited ? "result" : undefined,
		outputTruncated ? "output" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (flags.length === 0) return undefined;
	const found = input.scanTruncated ? `found>=${input.totalMatches}` : `found=${input.totalMatches}`;
	const selected = input.resultLimited ? ` selected=${input.matches.length}` : "";
	return `${found}${selected}; truncated=${flags.join(",")}`;
}

function takeBudgetedLines(lines: string[], tokenBudget: number): string[] {
	const result: string[] = [];
	for (const line of lines) {
		const next = [...result, line].join("\n");
		if (tokenCount(next) > tokenBudget) break;
		result.push(line);
	}
	return result;
}

function tokenCount(text: string): number {
	return countTextTokensSync(text).tokens;
}
