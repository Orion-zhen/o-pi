import { createHash } from "node:crypto";
import ignoreFactory from "ignore";

import type { FsOperationContext } from "../../contracts/result.js";
import type {
	IgnoreConfig,
	IgnoreDiagnostic,
	MatchedIgnoreRule,
	SessionIgnoreRule,
	VisibilityPolicy,
	VisibilitySourceType,
} from "../../contracts/visibility.js";
import type { NativeFileSystem } from "../../platform/node/native-filesystem.js";
import {
	SOURCE_PRIORITY,
	pathDepth,
	rethrowVisibilityAbort,
	type CompiledVisibilityRule,
	type CompiledVisibilityRuleSet,
	type VisibilityRuleFile,
} from "./model.js";

const BUILTIN_RULES: Readonly<Record<IgnoreConfig["builtinProfile"], readonly string[]>> = {
	none: [],
	minimal: ["node_modules/", ".DS_Store"],
	performance: ["node_modules/", "target/", ".venv/", "__pycache__/", ".pytest_cache/", ".gradle/", ".next/cache/"],
};

export interface CompiledVisibilityRules {
	readonly ruleSets: readonly CompiledVisibilityRuleSet[];
	readonly diagnostics: readonly IgnoreDiagnostic[];
}

export async function compileVisibilityRules(
	native: NativeFileSystem,
	ruleFiles: readonly VisibilityRuleFile[],
	config: IgnoreConfig,
	caseInsensitive: boolean,
	discoveryDiagnostics: readonly IgnoreDiagnostic[],
	context: FsOperationContext,
): Promise<CompiledVisibilityRules> {
	const diagnostics = [...discoveryDiagnostics];
	const ruleSets: CompiledVisibilityRuleSet[] = [];

	const builtinRules = BUILTIN_RULES[config.builtinProfile];
	if (builtinRules.length > 0) {
		const ruleSet = compileRuleLines({
			lines: builtinRules,
			sourceType: "builtin",
			baseDirectory: ".",
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	if (config.sessionRules.length > 0) {
		const ruleSet = compileRuleLines({
			lines: config.sessionRules.map(sessionRuleToPattern),
			sourceType: "session",
			baseDirectory: ".",
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	for (const file of ruleFiles) {
		const text = await readIgnoreFile(native, file, diagnostics, context);
		if (text === undefined) continue;
		const ruleSet = compileRuleLines({
			lines: text.split(/\n/),
			sourceType: file.sourceType,
			sourcePath: file.sourcePath,
			baseDirectory: file.baseDirectory,
			caseInsensitive,
			diagnostics,
		});
		if (ruleSet !== undefined) ruleSets.push(ruleSet);
	}

	return {
		ruleSets: ruleSets.sort((left, right) =>
			left.priority - right.priority || pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)),
		diagnostics,
	};
}

export function resolveCaseInsensitive(config: IgnoreConfig, gitIgnoreCase: boolean | undefined): boolean {
	if (config.caseSensitivity === "sensitive") return false;
	if (config.caseSensitivity === "insensitive") return true;
	if (gitIgnoreCase !== undefined) return gitIgnoreCase;
	return process.platform === "win32" || process.platform === "darwin";
}

export function buildVisibilityFingerprint(
	policy: VisibilityPolicy,
	caseInsensitive: boolean,
	ruleFiles: readonly VisibilityRuleFile[],
	trackedPaths: ReadonlySet<string>,
	diagnostics: readonly IgnoreDiagnostic[],
): string {
	const filePart = ruleFiles
		.map((file) => `${file.sourceType}:${file.sourcePath}:${file.stamp}`)
		.sort()
		.join("|");
	const trackedPart = Array.from(trackedPaths).sort().join("\0");
	const diagnosticPart = diagnostics.map((diagnostic) => `${diagnostic.sourcePath}:${diagnostic.line}:${diagnostic.code}`).join("|");
	return createHash("sha256")
		.update(JSON.stringify({ policyFingerprint: policy.fingerprint, caseInsensitive, filePart, trackedPart, diagnosticPart }))
		.digest("hex");
}

function compileRuleLines(input: {
	readonly lines: readonly string[];
	readonly sourceType: VisibilitySourceType;
	readonly sourcePath?: string;
	readonly baseDirectory: string;
	readonly caseInsensitive: boolean;
	readonly diagnostics: IgnoreDiagnostic[];
}): CompiledVisibilityRuleSet | undefined {
	const rules: CompiledVisibilityRule[] = [];
	const matcher = ignoreFactory({ ignorecase: input.caseInsensitive });
	let hasAnyRule = false;
	let hasNegatedRule = false;

	for (let index = 0; index < input.lines.length; index += 1) {
		const rawPattern = stripCarriageReturn(index === 0 ? stripBom(input.lines[index] ?? "") : (input.lines[index] ?? ""));
		const parsed = parseRule(rawPattern);
		if (parsed === undefined) continue;

		const ruleMatcher = ignoreFactory({ ignorecase: input.caseInsensitive });
		try {
			matcher.add(rawPattern);
			ruleMatcher.add(parsed.matchPattern);
		} catch (error) {
			input.diagnostics.push({
				sourcePath: input.sourcePath ?? `<${input.sourceType}>`,
				line: index + 1,
				code: "INVALID_IGNORE_PATTERN",
				message: error instanceof Error ? error.message : "Invalid ignore pattern.",
			});
			continue;
		}

		hasAnyRule = true;
		hasNegatedRule = hasNegatedRule || parsed.negated;
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

	if (!hasAnyRule) return undefined;
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
	diagnostics: IgnoreDiagnostic[],
	context: FsOperationContext,
): Promise<string | undefined> {
	try {
		const bytes = await native.read(file.absolutePath, context);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return decoder.decode(bytes).replace(/\r\n/g, "\n");
	} catch (error) {
		rethrowVisibilityAbort(error);
		diagnostics.push({
			sourcePath: file.sourcePath,
			code: isDecodeError(error) ? "UNSUPPORTED_IGNORE_ENCODING" : "IGNORE_FILE_READ_ERROR",
			message: isDecodeError(error) ? "Ignore file must be valid UTF-8." : "Ignore file could not be read.",
		});
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

function sessionRuleToPattern(rule: SessionIgnoreRule): string {
	return rule.action === "include" ? `!${rule.pattern}` : rule.pattern;
}

function stripBom(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function stripCarriageReturn(text: string): string {
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

function isDecodeError(error: unknown): boolean {
	return error instanceof TypeError;
}
