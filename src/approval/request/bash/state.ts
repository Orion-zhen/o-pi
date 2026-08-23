import path from "node:path";

import { isSystemTemporaryDescendant, normalizeTargetPath } from "../path.js";

// NUL 不可能出现在 shell 参数中，用作不可由输入伪造的内部路径根。
export const TEMPORARY_DIRECTORY_PATH = "\0temporary-directory";
export const TEMPORARY_FILE_PATH = "\0temporary-file";
const TEMPORARY_PATH_DISPLAY = "<temporary>";
export const UNKNOWN_DIRECTORY_PATH = "\0unknown-directory";

export interface ResolvedShellValue {
	value: string;
	temporary: boolean;
}

export interface BashAnalysisContext {
	cwd: ResolvedShellValue;
	variables: Map<string, ResolvedShellValue>;
	exitTraps: Set<string>;
}

export function setPositionalVariables(
	variables: Map<string, ResolvedShellValue>,
	args: Array<string | undefined>,
): void {
	for (const [index, value] of args.entries()) {
		if (value !== undefined) variables.set(String(index + 1), shellArgumentValue(value));
	}
}

export function shellArgumentValue(value: string): ResolvedShellValue {
	return { value, temporary: isSyntheticTemporaryPath(value) };
}

export function assignContext(target: BashAnalysisContext, source: BashAnalysisContext): void {
	target.cwd = { ...source.cwd };
	target.variables = new Map([...source.variables].map(([name, value]) => [name, { ...value }]));
	target.exitTraps = new Set(source.exitTraps);
}

export function joinContexts(contexts: readonly [BashAnalysisContext, ...BashAnalysisContext[]]): BashAnalysisContext {
	const [first, ...rest] = contexts;
	const variables = new Map<string, ResolvedShellValue>();
	for (const [name, firstValue] of first.variables) {
		const remainingValues = rest.map((context) => context.variables.get(name));
		if (!allDefined(remainingValues)) continue;
		const joined = joinValues([firstValue, ...remainingValues]);
		if (joined !== undefined) variables.set(name, joined);
	}
	return {
		cwd: joinValues([first.cwd, ...rest.map((context) => context.cwd)]) ?? { value: UNKNOWN_DIRECTORY_PATH, temporary: false },
		variables,
		exitTraps: new Set(contexts.flatMap((context) => [...context.exitTraps])),
	};
}

export function joinValues(values: readonly [ResolvedShellValue, ...ResolvedShellValue[]]): ResolvedShellValue | undefined {
	const [first] = values;
	if (values.every((value) => value.value === first.value && value.temporary === first.temporary)) return { ...first };
	if (values.every(isDefinitelyTemporaryPath)) return { value: TEMPORARY_DIRECTORY_PATH, temporary: true };
	return undefined;
}

export function allDefined<T>(values: Array<T | undefined>): values is T[] {
	return values.every((value) => value !== undefined);
}

export function singleValue<T>(values: readonly T[]): T | undefined {
	const iterator = values[Symbol.iterator]();
	const first = iterator.next();
	if (first.done || !iterator.next().done) return undefined;
	return first.value;
}

function isDefinitelyTemporaryPath(value: ResolvedShellValue): boolean {
	if (isSyntheticTemporaryPath(value.value)) return true;
	return path.isAbsolute(value.value) && isSystemTemporaryDescendant(normalizeTargetPath(value.value, "/"));
}

export function cloneContext(context: BashAnalysisContext): BashAnalysisContext {
	return {
		cwd: { ...context.cwd },
		variables: new Map([...context.variables].map(([name, value]) => [name, { ...value }])),
		exitTraps: new Set(context.exitTraps),
	};
}

export function resolvePath(
	input: ResolvedShellValue,
	cwd: ResolvedShellValue,
	fallbackCwd: string,
): ResolvedShellValue | undefined {
	if (input.temporary && isSyntheticTemporaryValue(input.value)) return normalizeSyntheticTemporaryPath(input.value);
	if (path.isAbsolute(input.value)) {
		return resolvedConcretePath(input.value, fallbackCwd);
	}
	if (cwd.value === UNKNOWN_DIRECTORY_PATH) return undefined;
	if (cwd.temporary && isSyntheticTemporaryValue(cwd.value)) {
		return isSyntheticTemporaryDirectory(cwd.value)
			? normalizeSyntheticTemporaryPath(`${cwd.value}/${input.value}`)
			: undefined;
	}
	return resolvedConcretePath(input.value, cwd.value);
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
	for (const segment of suffix.split("/")) {
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

export function isSyntheticTemporaryValue(value: string): boolean {
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
	allowUnquotedExpansion = false,
	allowGlob = false,
): ResolvedShellValue | undefined {
	let result = "";
	let quote: "'" | "\"" | undefined;
	let temporary = false;
	const append = (value: ResolvedShellValue): boolean => {
		if (value.temporary) {
			if (result.length > 0 || temporary) return false;
			temporary = true;
		}
		result += value.value;
		return true;
	};
	for (let index = 0; index < source.length; index += 1) {
		const character = source.charAt(index);
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (character === "\"") {
			quote = quote === "\"" ? undefined : "\"";
			continue;
		}
		if (character === "'" && quote === undefined) {
			quote = "'";
			continue;
		}
		if (character === "\\") {
			const next = source[index + 1];
			if (next === undefined) return undefined;
			if (next === "\n") {
				index += 1;
				continue;
			}
			if (quote === "\"" && next !== "$" && next !== "`" && next !== "\"" && next !== "\\") result += "\\";
			result += next;
			index += 1;
			continue;
		}
		if (character === "$") {
			if (quote === undefined && !allowUnquotedExpansion) return undefined;
			const expansion = resolveVariableExpansion(source, index, context);
			if (expansion === undefined || !append(expansion.value)) return undefined;
			index = expansion.end;
			continue;
		}
		if (character === "`") return undefined;
		if (quote === undefined && (character === "*" || character === "?" || character === "[") && !allowGlob) return undefined;
		if (quote === undefined && character === "{") return undefined;
		if (quote === undefined && character === "~" && index === 0) return undefined;
		result += character;
	}
	if (quote !== undefined) return undefined;
	if (!temporary) return { value: result, temporary: false };
	if (isSyntheticTemporaryValue(result)) return normalizeSyntheticTemporaryPath(result);
	return path.isAbsolute(result) ? resolvedConcretePath(result, "/") : undefined;
}

function resolveVariableExpansion(
	source: string,
	start: number,
	context: BashAnalysisContext,
): { value: ResolvedShellValue; end: number } | undefined {
	const next = source[start + 1];
	if (next === "$") return { value: { value: "*", temporary: false }, end: start + 1 };
	if (next === "{") {
		const end = source.indexOf("}", start + 2);
		if (end < 0) return undefined;
		const expression = source.slice(start + 2, end);
		const match = expression.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)(.*)$/u);
		const name = match?.[1];
		const modifier = match?.[2];
		if (name === undefined || modifier === undefined) return undefined;
		const value = variableValue(name, context);
		if (value === undefined || !preservesKnownValue(modifier, value)) return undefined;
		return { value, end };
	}
	const match = source.slice(start + 1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)/u);
	const name = match?.[0];
	if (name === undefined) return undefined;
	const value = variableValue(name, context);
	return value === undefined ? undefined : { value, end: start + name.length };
}

function variableValue(name: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (name === "PWD") return { ...context.cwd };
	if (name === "RANDOM" || name === "BASHPID" || name === "PPID" || name === "UID" || name === "EUID") {
		return { value: "*", temporary: false };
	}
	const value = context.variables.get(name);
	return value === undefined ? undefined : { ...value };
}

function preservesKnownValue(modifier: string, value: ResolvedShellValue): boolean {
	if (modifier.length === 0) return true;
	if (value.value.length === 0) return modifier.startsWith("?") || modifier.startsWith(":?");
	return modifier.startsWith("?") || modifier.startsWith(":?")
		|| modifier.startsWith("-") || modifier.startsWith(":-")
		|| modifier.startsWith("=") || modifier.startsWith(":=");
}
