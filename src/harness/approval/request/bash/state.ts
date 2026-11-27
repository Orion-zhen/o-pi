import path from "node:path";
import { IncompleteBashAnalysis, UNKNOWN_DIRECTORY, UNSET, readVariable, type BashAnalysisContext, type KnownValue, type ResolvedShellValue } from "./branches.ts";
import { decodeShellWord } from "../../../syntax-tree/bash.ts";

import type { ShellArg, NumericFileName } from "../../types.ts";
import { NUMERIC_FIELD } from "./syntax.ts";
import { isSystemTemporaryDescendant, isUnmappedBashPath, normalizeTargetPath, rulePath } from "../path.ts";

// NUL 不可能出现在 shell 参数中，用作不可由输入伪造的内部路径根。
export const TEMPORARY_DIRECTORY_PATH = "\0temporary-directory";
export const TEMPORARY_FILE_PATH = "\0temporary-file";
const TEMPORARY_PATH_DISPLAY = "<temporary>";
export const MAX_EXPANDED_FIELDS = 4096;
export const MAX_BINDING_LENGTH = 65536;

type Variables = BashAnalysisContext["variables"];

export function isPositionalVariable(key: string): boolean {
	return key === "#" || /^[1-9]\d*$/u.test(key);
}

export function clearPositionalVariables(variables: Variables): void {
	for (const key of variables.keys()) if (isPositionalVariable(key)) variables.delete(key);
}

export function restorePositionalVariables(variables: Variables, caller: Variables): void {
	clearPositionalVariables(variables);
	for (const [key, value] of caller) if (isPositionalVariable(key)) variables.set(key, value);
}

export function setPositionalVariables(variables: Variables, args: readonly ShellArg[]): void {
	clearPositionalVariables(variables);
	if (args.every(v => typeof v === "string")) variables.set("#", shellArgumentValue(String(args.length)));
	for (const [index, value] of args.entries()) {
		if (typeof value !== "string") break;
		variables.set(String(index + 1), shellArgumentValue(value));
	}
}

export function positionalValues(context: BashAnalysisContext): string[] | undefined {
	const count = plainParameter("#", context)?.value;
	if (count === undefined) return;
	if (Number(count) > MAX_EXPANDED_FIELDS) throw new IncompleteBashAnalysis();
	const args: string[] = [];
	for (let i = 1; i <= Number(count); i++) {
		const value = plainParameter(String(i), context)?.value;
		if (value === undefined || value.includes("\0")) return;
		args.push(value);
	}
	return args;
}

export function shellArgumentValue(value: string): ResolvedShellValue {
	return { value, temporary: isSyntheticTemporaryPath(value) };
}

export function allDefined<T>(values: Array<T | undefined>): values is T[] {
	return values.every((value) => value !== undefined);
}

export function singleValue<T>(values: readonly T[]): T | undefined {
	return values.length === 1 ? values[0] : undefined;
}

export function resolvePath(
	input: ResolvedShellValue,
	cwd: ResolvedShellValue,
): ResolvedShellValue | undefined {
	if (input.temporary && isSyntheticTemporaryValue(input.value)) return normalizeSyntheticTemporaryPath(input.value);
	if (input.value.startsWith("skill://")) return { value: input.value, temporary: false };
	if (isUnmappedBashPath(input.value)) return undefined;
	if (path.isAbsolute(input.value)) return resolvedConcretePath(input.value, cwd.value);
	if (cwd.value === UNKNOWN_DIRECTORY.value) return undefined;
	if (cwd.temporary && isSyntheticTemporaryValue(cwd.value)) {
		return isSyntheticTemporaryDirectory(cwd.value)
			? normalizeSyntheticTemporaryPath(`${cwd.value}/${input.value}`)
			: undefined;
	}
	return resolvedConcretePath(input.value, cwd.value);
}

interface PathCandidate {
	value: string;
	directory?: string;
	numericName?: NumericFileName;
	temporary: boolean;
}

export function resolvePathCandidates(input: ResolvedShellValue, cwd: ResolvedShellValue): Array<PathCandidate | undefined> {
	if (input.value.includes(NUMERIC_FIELD)) return [numericPathCandidate(input, cwd)];
	if (input.fileDirectory === undefined) return [resolvePath(input, cwd)];
	const suffix = input.value.slice(TEMPORARY_FILE_PATH.length);
	const value = path.join(input.fileDirectory, `<generated>${suffix}`);
	const generated = { value, directory: input.fileDirectory, temporary: input.temporary || isSystemTemporaryDescendant(value) };
	// 空文件名不能成为写入目标。拼接后非空的另一种结果按当前目录解析。
	if (suffix === "") return [generated];
	return [generated, resolvePath({ value: suffix, temporary: false }, cwd)];
}

function numericPathCandidate(input: ResolvedShellValue, cwd: ResolvedShellValue): PathCandidate | undefined {
	if (path.dirname(input.value).includes(NUMERIC_FIELD) || input.value.startsWith("skill://")) return undefined;
	const target = resolvePath(input, cwd);
	if (target === undefined || isSyntheticTemporaryPath(target.value)) return undefined;
	if ([input.value, target.value].some((value) => /[*?[\]{}()<>`]/u.test(value))) return undefined;
	const [prefix, suffix, extra] = path.basename(target.value).split(NUMERIC_FIELD);
	if (prefix === undefined || suffix === undefined || extra !== undefined) return undefined;
	return {
		value: target.value.replace(NUMERIC_FIELD, "<number>"),
		directory: rulePath(path.dirname(target.value)),
		numericName: { prefix, suffix },
		temporary: target.temporary,
	};
}

function resolvedConcretePath(value: string, cwd: string): ResolvedShellValue {
	const normalized = normalizeTargetPath(value, cwd);
	return { value: normalized, temporary: isSystemTemporaryDescendant(normalized) };
}

function normalizeSyntheticTemporaryPath(value: string): ResolvedShellValue | undefined {
	if (value === TEMPORARY_FILE_PATH) return { value, temporary: true };
	if (!isSyntheticTemporaryDirectory(value)) return undefined;
	const suffix = value.slice(TEMPORARY_DIRECTORY_PATH.length);
	const segments: string[] = [];
	for (const segment of suffix.split(path.sep === "\\" ? /[/\\]/u : "/")) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		if (segment === TEMPORARY_DIRECTORY_PATH) return undefined;
		segments.push(segment);
	}
	return {
		value: segments.length === 0 ? TEMPORARY_DIRECTORY_PATH : `${TEMPORARY_DIRECTORY_PATH}/${segments.join("/")}`,
		temporary: true,
	};
}

export function isSyntheticTemporaryPath(value: string): boolean {
	return value === TEMPORARY_FILE_PATH || isSyntheticTemporaryDirectory(value);
}

function isSyntheticTemporaryValue(value: string): boolean {
	return value.startsWith(TEMPORARY_FILE_PATH) || value.startsWith(TEMPORARY_DIRECTORY_PATH);
}

function isSyntheticTemporaryDirectory(value: string): boolean {
	return value === TEMPORARY_DIRECTORY_PATH || value.startsWith(`${TEMPORARY_DIRECTORY_PATH}/`);
}

export function displayTemporaryPath(value: string): string {
	if (value === TEMPORARY_FILE_PATH) return TEMPORARY_PATH_DISPLAY;
	return isSyntheticTemporaryDirectory(value)
		? `${TEMPORARY_PATH_DISPLAY}${value.slice(TEMPORARY_DIRECTORY_PATH.length)}`
		: value;
}

export function resolveShellToken(
	source: string,
	context: BashAnalysisContext,
	allowUnquotedExpansion: boolean,
	allowGlob: boolean,
): ResolvedShellValue | undefined {
	let temporary = false;
	let fileDirectory: string | undefined;
	const tilde = source.startsWith("~");
	// 赋值右侧的冒号还可能引入另一个波浪号展开。
	if (tilde && (allowUnquotedExpansion && source.includes(":~") || /[<>()]/u.test(source))) return undefined;
	const result = decodeShellWord(source, {
		allowUnquotedExpansion,
		ansiQuotes: context.bash,
		allowGlob: allowGlob && !tilde,
		resolveHome: () => absoluteHome(context),
		resolveExpansion(text, start, prefix) {
			const expansion = resolveVariableExpansion(text, start, context);
			if (expansion === undefined) return undefined;
			if (expansion.value.temporary || expansion.value.fileDirectory !== undefined) {
				if (prefix.length > 0 || temporary) return undefined;
				temporary = true;
				fileDirectory = expansion.value.fileDirectory;
			}
			return { value: expansion.value.value, end: expansion.end };
		},
	});
	if (result === undefined) return undefined;
	if (result.includes(NUMERIC_FIELD)) {
		return fileDirectory !== undefined || isSyntheticTemporaryValue(result) ? undefined : { value: result, temporary: false };
	}
	if (!temporary) return { value: result, temporary: false };
	if (fileDirectory !== undefined && result.startsWith(TEMPORARY_FILE_PATH)) {
		const suffix = result.slice(TEMPORARY_FILE_PATH.length);
		if (/[/\\\0*?[{}]/u.test(suffix)) return undefined;
		return { value: result, temporary: suffix === "", fileDirectory };
	}
	if (isSyntheticTemporaryValue(result)) return normalizeSyntheticTemporaryPath(result);
	return path.isAbsolute(result) ? resolvePath({ value: result, temporary: false }, UNKNOWN_DIRECTORY) : undefined;
}

function resolveVariableExpansion(
	source: string,
	start: number,
	context: BashAnalysisContext,
): { value: ResolvedShellValue; end: number } | undefined {
	const next = source[start + 1];
	if (next === "{") {
		const end = source.indexOf("}", start + 2);
		if (end < 0) return undefined;
		const expression = source.slice(start + 2, end);
		const match = expression.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)(.*)$/u);
		const name = match?.[1];
		const modifier = match?.[2];
		if (name === undefined || modifier === undefined) return undefined;
		if (modifier.includes("{") || modifier.includes("\\")) return undefined;
		const stored = variableValue(name, context);
		const index = /^\[(0|[1-9]\d*)\]$/u.exec(modifier)?.[1];
		if (index !== undefined && stored && stored !== UNSET && stored.elements) {
			const item = stored.elements[Number(index)];
			return item === undefined ? undefined : { value: shellArgumentValue(item), end };
		}
		const value = parameterValue(stored, modifier, context);
		return value === undefined ? undefined : { value, end };
	}
	const match = source.slice(start + 1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9])/u);
	const name = match?.[0];
	if (name === undefined) return undefined;
	const value = plainParameter(name, context);
	return value === undefined ? undefined : { value, end: start + name.length };
}

function variableValue(name: string, context: BashAnalysisContext): KnownValue | undefined {
	if (name === "PWD") {
		const cwd = singleValue(context.cwd);
		return cwd?.value === UNKNOWN_DIRECTORY.value ? undefined : cwd;
	}
	const variable = readVariable(name, context);
	return variable === UNSET || (variable !== undefined && !("choices" in variable)) ? variable : undefined;
}

export function absoluteHome(context: BashAnalysisContext): string | undefined {
	const home = variableValue("HOME", context);
	return home !== undefined && home !== UNSET && !home.value.includes("\0") && path.isAbsolute(home.value) && !isUnmappedBashPath(home.value)
		? home.value : undefined;
}

export function plainParameter(name: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	const value = variableValue(name, context);
	return value === UNSET ? { value: "", temporary: false } : value;
}

function parameterValue(value: KnownValue | undefined, modifier: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (value === undefined) return undefined;
	if (value !== UNSET && value.fileDirectory !== undefined && modifier !== "") return undefined;
	if (value !== UNSET && preservesKnownValue(modifier, value)) return value;
	if (value === UNSET && modifier === "") return { value: "", temporary: false };
	const operator = /^(:?[-+])/u.exec(modifier)?.[1];
	if (operator) {
		if (operator.endsWith("+") && value !== UNSET && (value.temporary || value.value.includes("\0"))) return;
		const absent = value === UNSET || operator.startsWith(":") && value.value === "";
		if (operator.endsWith("+") && absent) return shellArgumentValue("");
		const fallback = modifier.slice(operator.length);
		if (/^\$[a-zA-Z_][a-zA-Z_0-9]*$/u.test(fallback)) return plainParameter(fallback.slice(1), context);
		return /^[\p{L}\p{M}\p{N}_./-]*$/u.test(fallback) ? { value: fallback, temporary: false } : undefined;
	}
	if (value === UNSET || value.temporary || value.value.includes("\0")) return undefined;
	if (modifier === "##*/") return { value: value.value.slice(value.value.lastIndexOf("/") + 1), temporary: false };
	const trim = modifier.match(/^(#{1,2}|%{1,2})([\w./-]+)$/u);
	const literal = trim?.[2];
	if (literal === undefined) return undefined;
	const text = value.value;
	if (modifier.startsWith("#") && text.startsWith(literal)) return { value: text.slice(literal.length), temporary: false };
	if (modifier.startsWith("%") && text.endsWith(literal)) return { value: text.slice(0, -literal.length), temporary: false };
	return value;
}

function preservesKnownValue(modifier: string, value: ResolvedShellValue): boolean {
	if (modifier.length === 0) return true;
	if (value.value.length === 0) return modifier.startsWith("?") || modifier.startsWith("-");
	return modifier.startsWith("?") || modifier.startsWith(":?")
		|| modifier.startsWith("-") || modifier.startsWith(":-")
		|| modifier.startsWith("=") || modifier.startsWith(":=");
}
