import path from "node:path";
import { decodeShellWord } from "../../../syntax-tree/bash.ts";

import type { BashArg, NumericFileName } from "../../types.ts";
import { NUMERIC_FIELD } from "./syntax.ts";
import { isSystemTemporaryDescendant, isUnmappedBashPath, normalizeTargetPath, rulePath } from "../path.ts";

// NUL 不可能出现在 shell 参数中，用作不可由输入伪造的内部路径根。
export const TEMPORARY_DIRECTORY_PATH = "\0temporary-directory";
export const TEMPORARY_FILE_PATH = "\0temporary-file";
const TEMPORARY_PATH_DISPLAY = "<temporary>";
export const UNKNOWN_DIRECTORY_PATH = "\0unknown-directory";

export interface ResolvedShellValue {
	readonly value: string;
	readonly temporary: boolean;
	/** 已知父目录时，value 用临时文件标记代表生成的路径。命令没有输出时该标记为空串。 */
	readonly fileDirectory?: string;
}

export const MAX_BRANCH_CHOICES = 8;
export type Directories = readonly ResolvedShellValue[];
export const UNKNOWN_DIRECTORY: ResolvedShellValue = { value: UNKNOWN_DIRECTORY_PATH, temporary: false };
export const UNSET = Symbol("unset");
type KnownValue = ResolvedShellValue | typeof UNSET;
type Binding = KnownValue | { startup: KnownValue };
type VariableValue = Binding | { choices: Binding[] };

function bindingValue(binding: Binding): KnownValue {
	return binding !== UNSET && "startup" in binding ? binding.startup : binding;
}

export interface BashAnalysisContext {
	readonly functionNames: ReadonlySet<string>;
	readonly simpleSites?: ReadonlySet<number> | undefined;
	usedEnvironment?: Map<string, string | null>;
	cwd: Directories;
	variables: Map<string, VariableValue>;
	exitTraps: Set<string>;
}

export function setPositionalVariables(
	variables: Map<string, VariableValue>,
	args: readonly BashArg[],
): void {
	for (const key of variables.keys()) if (/^[1-9]\d*$/u.test(key)) variables.delete(key);
	for (const [index, value] of args.entries()) {
		if (typeof value !== "string") break;
		variables.set(String(index + 1), shellArgumentValue(value));
	}
}

export function shellArgumentValue(value: string): ResolvedShellValue {
	return { value, temporary: isSyntheticTemporaryPath(value) };
}

export function assignContext(target: BashAnalysisContext, source: BashAnalysisContext): void {
	target.cwd = source.cwd;
	target.variables = new Map(source.variables);
	target.exitTraps = new Set(source.exitTraps);
}

export function joinContexts(contexts: readonly [BashAnalysisContext, ...BashAnalysisContext[]]): BashAnalysisContext {
	const [first, ...rest] = contexts;
	const variables = new Map<string, VariableValue>();
	for (const [name, firstValue] of first.variables) {
		const remainingValues = rest.map((context) => context.variables.get(name));
		if (!allDefined(remainingValues)) continue;
		const joined = joinVariable([firstValue, ...remainingValues]);
		if (joined !== undefined) variables.set(name, joined);
	}
	return {
		...first,
		cwd: joinDirectories(contexts.flatMap((context) => context.cwd)),
		variables,
		exitTraps: new Set(contexts.flatMap((context) => [...context.exitTraps])),
	};
}

function sameValue(a: ResolvedShellValue, b: ResolvedShellValue): boolean {
	return a.value === b.value && a.temporary === b.temporary && a.fileDirectory === b.fileDirectory;
}

function boundedChoices<T>(values: readonly T[], equal: (a: T, b: T) => boolean): T[] | undefined {
	const choices: T[] = [];
	for (const item of values) {
		if (choices.some((other) => equal(other, item))) continue;
		if (choices.length === MAX_BRANCH_CHOICES) return undefined;
		choices.push(item);
	}
	return choices;
}

export function joinDirectories(values: Directories): Directories {
	return boundedChoices(values, sameValue) ?? [UNKNOWN_DIRECTORY];
}

function joinVariable(values: VariableValue[]): VariableValue | undefined {
	const bindings = values.flatMap<Binding>((value) => value !== UNSET && "choices" in value ? value.choices : [value]);
	const startup = bindings.find((item) => item !== UNSET && "startup" in item);
	const choices = boundedChoices(bindings.map(bindingValue), sameKnownValue);
	if (!choices) return undefined;
	// 相同值只占一个候选。任一分支仍依赖启动值时，合并后保留来源。
	const merged = choices.map((value) => startup && sameKnownValue(value, startup.startup) ? startup : value);
	if (merged.length === 1) return merged[0];
	return choices.some((item) => item !== UNSET && item.fileDirectory !== undefined) ? undefined : { choices: merged };
}

function sameKnownValue(a: KnownValue, b: KnownValue): boolean {
	return a === b || a !== UNSET && b !== UNSET && sameValue(a, b);
}

export function allDefined<T>(values: Array<T | undefined>): values is T[] {
	return values.every((value) => value !== undefined);
}

export function singleValue<T>(values: readonly T[]): T | undefined {
	return values.length === 1 ? values[0] : undefined;
}

export function cloneContext(context: BashAnalysisContext): BashAnalysisContext {
	return {
		...context,
		variables: new Map(context.variables),
		exitTraps: new Set(context.exitTraps),
	};
}

export function resolvePath(
	input: ResolvedShellValue,
	cwd: ResolvedShellValue,
): ResolvedShellValue | undefined {
	if (input.temporary && isSyntheticTemporaryValue(input.value)) return normalizeSyntheticTemporaryPath(input.value);
	if (input.value.startsWith("skill://")) return { value: input.value, temporary: false };
	if (isUnmappedBashPath(input.value)) return undefined;
	if (path.isAbsolute(input.value)) return resolvedConcretePath(input.value, cwd.value);
	if (cwd.value === UNKNOWN_DIRECTORY_PATH) return undefined;
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
		const value = parameterValue(variableValue(name, context), modifier, context);
		return value === undefined ? undefined : { value, end };
	}
	const match = source.slice(start + 1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9])/u);
	const name = match?.[0];
	if (name === undefined) return undefined;
	const value = plainParameter(name, context);
	return value === undefined ? undefined : { value, end: start + name.length };
}

export function readVariable(name: string, context: BashAnalysisContext) {
	const binding = context.variables.get(name);
	const read = (entry: Binding): KnownValue => {
		if (entry === UNSET || !("startup" in entry)) return entry;
		context.usedEnvironment?.set(name, entry.startup === UNSET ? null : entry.startup.value);
		return entry.startup;
	};
	if (binding === undefined) return undefined;
	return binding !== UNSET && "choices" in binding ? { choices: binding.choices.map(read) } : read(binding);
}

function variableValue(name: string, context: BashAnalysisContext): KnownValue | undefined {
	if (name === "PWD") {
		const cwd = singleValue(context.cwd);
		return cwd?.value === UNKNOWN_DIRECTORY_PATH ? undefined : cwd;
	}
	const variable = readVariable(name, context);
	return variable === UNSET || (variable !== undefined && !("choices" in variable)) ? variable : undefined;
}

export function absoluteHome(context: BashAnalysisContext): string | undefined {
	const home = variableValue("HOME", context);
	return home !== undefined && home !== UNSET && !home.value.includes("\0") && path.isAbsolute(home.value) && !isUnmappedBashPath(home.value)
		? home.value : undefined;
}

function plainParameter(name: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	const value = variableValue(name, context);
	return value === UNSET ? { value: "", temporary: false } : value;
}

function parameterValue(value: KnownValue | undefined, modifier: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (value === undefined) return undefined;
	if (value !== UNSET && value.fileDirectory !== undefined && modifier !== "") return undefined;
	if (value !== UNSET && preservesKnownValue(modifier, value)) return value;
	if (value === UNSET && modifier === "") return { value: "", temporary: false };
	if ((modifier.startsWith("-") && value === UNSET) || (modifier.startsWith(":-") && (value === UNSET || value.value === ""))) {
		const fallback = modifier.slice(modifier.startsWith(":") ? 2 : 1);
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
