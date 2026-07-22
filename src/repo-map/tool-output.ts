import { countTextTokensSync } from "../token-counter.js";
import type { RepoMapReadContext } from "./file-tool-query.js";
import type { RepoMapImpactResult } from "./impact.js";
import { DEFAULT_REPO_MAP_OUTPUT_CONFIG, type RepoMapOutputConfig } from "./output-config.js";

export const READ_REPO_MAP_TOKEN_BUDGET = DEFAULT_REPO_MAP_OUTPUT_CONFIG.read_context_token_budget;
export const REPO_IMPACT_TOKEN_BUDGET = DEFAULT_REPO_MAP_OUTPUT_CONFIG.mutation_impact_token_budget;

interface OutputAttribute {
	name: string;
	values: string[];
}

interface OutputAttributeGroup {
	name: string;
	values: readonly string[];
	compactLimit: number;
}

/** Render only model-actionable read context under a hard token budget. */
export function formatRepoMapReadContext(
	context: RepoMapReadContext | undefined,
	config: RepoMapOutputConfig = DEFAULT_REPO_MAP_OUTPUT_CONFIG,
): string | undefined {
	if (context === undefined) return undefined;
	const symbolName = context.symbol.qualifiedName ?? context.symbol.name ?? "anonymous";
	const attrs: OutputAttribute[] = [];
	const budget = config.read_context_token_budget;
	if (!appendAttributeValue(attrs, "repo_map", "symbol", compact(`${context.symbol.kind} ${symbolName} ${context.symbol.startLine}-${context.symbol.endLine}`, 120), budget)) {
		return undefined;
	}
	if (context.publicApi) appendAttributeValue(attrs, "repo_map", "public_api", "true", budget);
	if (context.package !== undefined) appendAttributeValue(attrs, "repo_map", "package", compact(context.package, 64), budget);
	if (context.component !== undefined) appendAttributeValue(attrs, "repo_map", "component", compact(context.component, 64), budget);
	appendAttributeGroups(attrs, "repo_map", [
		{ name: "tests", values: context.relatedTests ?? [], compactLimit: 80 },
		{ name: "callers", values: context.callers, compactLimit: 96 },
		{ name: "callees", values: context.callees, compactLimit: 96 },
		{ name: "references", values: context.references, compactLimit: 96 },
		{ name: "imports", values: context.imports, compactLimit: 96 },
		{ name: "entrypoints", values: context.entrypoints ?? [], compactLimit: 80 },
	], budget);
	return renderBlock("repo_map", attrs);
}

/** Render mutation impact without repeating facts already present on the outer write/edit result. */
export function formatRepoMapImpact(
	impact: RepoMapImpactResult | undefined,
	config: RepoMapOutputConfig = DEFAULT_REPO_MAP_OUTPUT_CONFIG,
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
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
