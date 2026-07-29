import { countTextTokensSync } from "../../token-counter.js";
import type { RepoMapReadContext } from "../query/file-tool-query.js";
import type { RepoMapImpactResult } from "../query/impact.js";
import { defaultRepoMapConfig } from "../config/config.js";
import type { RepoMapOutputConfig } from "../config/output-config.js";

const defaultOutputConfig = defaultRepoMapConfig().output;
export const REPO_IMPACT_TOKEN_BUDGET = defaultOutputConfig.mutation_impact_token_budget;

interface OutputAttribute {
	name: string;
	values: string[];
}

interface OutputAttributeGroup {
	name: string;
	values: readonly string[];
	compactLimit: number;
}

/** Render only model-actionable read suggestions. */
export function formatRepoMapReadContext(
	context: RepoMapReadContext | undefined,
	config: RepoMapOutputConfig = defaultOutputConfig,
): string | undefined {
	if (context === undefined) return undefined;
	const lines = [
		...context.suggestedReads.slice(0, config.read_suggestion_limit)
			.map((suggestion) => `sugessted read: ${escapeXmlText(formatReadSuggestion(suggestion))}`),
		...context.suggestedTests.slice(0, config.read_test_limit)
			.map((filePath) => `sugessted test: ${escapeXmlText(compact(filePath, 120))}`),
	];
	return lines.length === 0 ? undefined : `<repo_map>\n${lines.join("\n")}\n</repo_map>`;
}

/** Render mutation impact without repeating facts already present on the outer write/edit result. */
export function formatRepoMapImpact(
	impact: RepoMapImpactResult | undefined,
	config: RepoMapOutputConfig = defaultOutputConfig,
): string | undefined {
	if (impact === undefined) return undefined;
	const budget = config.mutation_impact_token_budget;
	const publicChanges = new Set(impact.publicApiChanges);
	const symbolChanges = [...impact.changedSymbols, ...impact.publicApiChanges.filter((value) => !impact.changedSymbols.includes(value))]
		.map((value) => compact(`${publicChanges.has(value) ? "api " : ""}${value}`, 72));
	const attrs: OutputAttribute[] = [];
	const tests = uniquePaths(impact.candidates.filter((candidate) => candidate.role === "test"));
	const testPaths = new Set(tests.map((candidate) => candidate.path));
	const affected = uniquePaths(impact.candidates.filter((candidate) => candidate.role !== "changed"
		&& candidate.role !== "test"
		&& candidate.path !== impact.changedPath
		&& !testPaths.has(candidate.path)));
	appendAttributeGroups(attrs, "repo_impact", [
		{ name: "symbols", values: symbolChanges, compactLimit: 72 },
		{ name: "affected", values: affected.map((candidate) => `${compact(candidate.path, 72)}:${candidate.role}`), compactLimit: 96 },
		{ name: "tests", values: tests.map((candidate) => candidate.path), compactLimit: 80 },
	], budget);
	return attrs.length === 0 ? undefined : renderBlock("repo_impact", attrs);
}

function uniquePaths<T extends { path: string }>(values: readonly T[]): T[] {
	const paths = new Set<string>();
	const result: T[] = [];
	for (const value of values) {
		if (paths.has(value.path)) continue;
		paths.add(value.path);
		result.push(value);
	}
	return result;
}

function compact(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function formatReadSuggestion(suggestion: RepoMapReadContext["suggestedReads"][number]): string {
	const location = `${compact(suggestion.path, 120)}${suggestion.line === undefined ? "" : `:${suggestion.line}`}`;
	const target = suggestion.symbol === undefined ? suggestion.relation : `${suggestion.relation} ${compact(suggestion.symbol, 80)}`;
	return `${location} (${target})`;
}

function appendAttributeGroups(
	attrs: OutputAttribute[],
	blockName: string,
	groups: readonly OutputAttributeGroup[],
	tokenBudget: number,
): void {
	const blocked = new Set<string>();
	const rounds = Math.max(0, ...groups.map((group) => group.values.length));
	for (let index = 0; index < rounds; index += 1) {
		let added = false;
		for (const group of groups) {
			if (blocked.has(group.name)) continue;
			const value = group.values[index];
			if (value === undefined) {
				blocked.add(group.name);
				continue;
			}
			if (appendAttributeValue(attrs, blockName, group.name, compact(value, group.compactLimit), tokenBudget)) added = true;
			else blocked.add(group.name);
		}
		if (!added) break;
	}
}

function appendAttributeValue(
	attrs: OutputAttribute[],
	blockName: string,
	attributeName: string,
	value: string,
	tokenBudget: number,
): boolean {
	const index = attrs.findIndex((attribute) => attribute.name === attributeName);
	const candidate = attrs.map((attribute) => ({ ...attribute, values: [...attribute.values] }));
	if (index === -1) candidate.push({ name: attributeName, values: [value] });
	else {
		const attribute = candidate[index];
		if (attribute === undefined) return false;
		attribute.values.push(value);
	}
	if (countTextTokensSync(renderBlock(blockName, candidate)).tokens > tokenBudget) return false;
	attrs.splice(0, attrs.length, ...candidate);
	return true;
}

function renderBlock(name: string, attrs: readonly OutputAttribute[]): string {
	const fields = attrs.map((attribute) => `${attribute.name}="${escapeXmlAttribute(attribute.values.join(", "))}"`);
	return `<${name}>\n${fields.join(" ")}\n</${name}>`;
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
