import { createHash } from "node:crypto";
import ignoreFactory from "ignore";

import type { FsOperationContext } from "../../contracts/result.js";
import type { IgnoreConfig, VisibilityPolicy } from "../../contracts/visibility.js";
import type { NativeFileSystem } from "../../platform/node/native-filesystem.js";
import {
	SOURCE_PRIORITY,
	pathDepth,
	rethrowVisibilityAbort,
	type CompiledVisibilityRule,
	type CompiledVisibilityRuleSet,
	type MatchedIgnoreRule,
	type VisibilityRuleFile,
	type VisibilitySourceType,
} from "./model.js";

const BUILTIN_RULES: Readonly<Record<IgnoreConfig["builtinProfile"], readonly string[]>> = {
	none: [],
	minimal: ["node_modules/", ".DS_Store"],
	performance: ["node_modules/", "target/", ".venv/", "__pycache__/", ".pytest_cache/", ".gradle/", ".next/cache/"],
};

export interface CompiledVisibilityRules {
	readonly ruleSets: readonly CompiledVisibilityRuleSet[];
}

export function compileBaseVisibilityRules(
	config: IgnoreConfig,
	caseInsensitive: boolean,
): CompiledVisibilityRules {
	const rules = BUILTIN_RULES[config.builtinProfile];
	const ruleSet = rules.length === 0
		? undefined
		: compileRuleLines({
			lines: rules,
			sourceType: "builtin",
			baseDirectory: ".",
			caseInsensitive,
		});
	return { ruleSets: ruleSet === undefined ? [] : [ruleSet] };
}

export async function compileVisibilityRuleFiles(
	native: NativeFileSystem,
	ruleFiles: readonly VisibilityRuleFile[],
	caseInsensitive: boolean,
	context: FsOperationContext,
): Promise<CompiledVisibilityRules> {
	const ruleSets: CompiledVisibilityRuleSet[] = [];
	for (const file of ruleFiles) {
		const text = await readIgnoreFile(native, file, context);
		if (text === undefined) continue;
		const ruleSet = compileRuleLines({
			lines: text.split(/\n/),
			sourceType: file.sourceType,
			sourcePath: file.sourcePath,
			baseDirectory: file.baseDirectory,
			caseInsensitive,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}
	return { ruleSets: ruleSets.sort(compareRuleSets) };
}

export function resolveCaseInsensitive(gitIgnoreCase: boolean | undefined): boolean {
	if (gitIgnoreCase !== undefined) return gitIgnoreCase;
	return process.platform === "win32" || process.platform === "darwin";
}

export function buildVisibilityFingerprint(
	policy: VisibilityPolicy,
	caseInsensitive: boolean,
	ruleFiles: readonly VisibilityRuleFile[],
	trackedPaths: ReadonlySet<string>,
): string {
	const filePart = ruleFiles
		.map((file) => `${file.sourceType}:${file.sourcePath}:${file.stamp}`)
		.sort()
		.join("|");
	const trackedPart = Array.from(trackedPaths).sort().join("\0");
	return createHash("sha256")
		.update(JSON.stringify({ policyFingerprint: policy.fingerprint, caseInsensitive, filePart, trackedPart }))
		.digest("hex");
}

function compileRuleLines(input: {
	readonly lines: readonly string[];
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath?: string;
	readonly baseDirectory: string;
	readonly caseInsensitive: boolean;
}): CompiledVisibilityRuleSet | undefined {
	const rules: CompiledVisibilityRule[] = [];
	const acceptedPatterns: string[] = [];
	let hasNegatedRule = false;

	for (let index = 0; index < input.lines.length; index += 1) {
		const rawPattern = stripCarriageReturn(index === 0 ? stripBom(input.lines[index] ?? "") : (input.lines[index] ?? ""));
		const parsed = parseRule(rawPattern);
		if (parsed === undefined) continue;

		const ruleMatcher = ignoreFactory({ ignorecase: input.caseInsensitive });
		try {
			ignoreFactory({ ignorecase: input.caseInsensitive }).add(rawPattern);
			ruleMatcher.add(parsed.matchPattern);
		} catch {
			continue;
		}

		hasNegatedRule = hasNegatedRule || parsed.negated;
		acceptedPatterns.push(rawPattern);
		const rule: MatchedIgnoreRule = {
			sourceType: input.sourceType,
			sourcePath: input.sourcePath,
			line: input.sourcePath === undefined ? undefined : index + 1,
			pattern: rawPattern,
			negated: parsed.negated,
			baseDirectory: input.baseDirectory,
			priority: SOURCE_PRIORITY[input.sourceType],
		};
		rules.push({ rule, matcher: ruleMatcher, directoryOnly: parsed.directoryOnly });
	}

	if (rules.length === 0) return undefined;
	const matcher = ignoreFactory({ ignorecase: input.caseInsensitive });
	matcher.add(acceptedPatterns);
	return {
		sourceType: input.sourceType,
		sourcePath: input.sourcePath,
		baseDirectory: input.baseDirectory,
		priority: SOURCE_PRIORITY[input.sourceType],
		matcher,
		rules,
		hasNegatedRule,
	};
}

async function readIgnoreFile(
	native: NativeFileSystem,
	file: VisibilityRuleFile,
	context: FsOperationContext,
): Promise<string | undefined> {
	try {
		const bytes = await native.read(file.absolutePath, context);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
	} catch (error) {
		rethrowVisibilityAbort(error);
		return undefined;
	}
}

function parseRule(pattern: string): { negated: boolean; matchPattern: string; directoryOnly: boolean } | undefined {
	if (pattern.trim() === "" || pattern.startsWith("#")) return undefined;
	if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
		return { negated: false, matchPattern: pattern, directoryOnly: pattern.trimEnd().endsWith("/") };
	}
	const negated = pattern.startsWith("!");
	const matchPattern = negated ? pattern.slice(1) : pattern;
	return { negated, matchPattern, directoryOnly: matchPattern.trimEnd().endsWith("/") };
}

function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function stripCarriageReturn(text: string): string {
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function compareRuleSets(left: CompiledVisibilityRuleSet, right: CompiledVisibilityRuleSet): number {
	return left.priority - right.priority
		|| pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)
		|| (left.sourcePath ?? "").localeCompare(right.sourcePath ?? "");
}
