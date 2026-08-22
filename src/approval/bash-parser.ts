import os from "node:os";
import path from "node:path";

import { containsDynamicShellNode, decodeStaticShellWord } from "../syntax-tree/bash.js";
import { getTreeSitterLanguage } from "../syntax-tree/grammars.js";
import { parseSyntaxTree } from "../syntax-tree/parser.js";
import type { SyntaxNode } from "../syntax-tree/types.js";
import { normalizeTargetPath } from "./path.js";
import type { ApprovalUnit } from "./types.js";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
// NUL 不可能出现在 shell 参数中，用作不可由输入伪造的内部路径根。
const TEMPORARY_DIRECTORY_PATH = "\0temporary-directory";
const TEMPORARY_FILE_PATH = "\0temporary-file";
const TEMPORARY_PATH_DISPLAY = "<temporary>";
const SYSTEM_TEMPORARY_ROOTS = systemTemporaryRoots();
const BASH_GRAMMAR = getTreeSitterLanguage("bash").grammar;
const SHELL_PROGRAMS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u",
	"--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user",
]);

interface ParsedBashUnits {
	units: ApprovalUnit[];
}

interface CommandFacts {
	program: string | undefined;
	args: Array<string | undefined>;
}

interface ResolvedShellValue {
	value: string;
	temporary: boolean;
}

interface BashAnalysisContext {
	cwd: ResolvedShellValue;
	variables: Map<string, ResolvedShellValue>;
}

interface BashAnalysisState {
	cwd: string;
	depth: number;
	units: ApprovalUnit[];
	stableAssignments: ReadonlySet<string>;
}

class BashUnitLimitError extends Error {}

/** 将 Bash AST 拆成可独立匹配的简单命令和文件写重定向。 */
export async function parseBashApprovalUnits(command: string, cwd: string): Promise<ParsedBashUnits> {
	try {
		const units: ApprovalUnit[] = [];
		const parsed = await parseScript(command, cwd, 0, units);
		if (!parsed) return { units: [opaqueCommandUnit(command)] };
		if (units.length === 0) units.push(plainCommandUnit(command));
		return { units };
	} catch {
		return { units: [opaqueCommandUnit(command)] };
	}
}

function opaqueCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: `<opaque> ${command}` },
		remember: { session: true, persistent: false },
	};
}

function plainCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: command },
		remember: { session: true, persistent: true },
	};
}

async function parseScript(script: string, cwd: string, depth: number, units: ApprovalUnit[]): Promise<boolean> {
	if (depth > MAX_NESTED_SHELL_DEPTH) throw new BashUnitLimitError();
	const parsed = await parseSyntaxTree(BASH_GRAMMAR, script);
	const document = parsed.document;
	if (document === undefined) return false;
	try {
		if (document.root.hasError) return false;
		const state: BashAnalysisState = {
			cwd,
			depth,
			units,
			stableAssignments: stableAssignmentNames(document.root, document.control.check),
		};
		const normalizedCwd = normalizeTargetPath(".", cwd);
		const context: BashAnalysisContext = {
			cwd: { value: normalizedCwd, temporary: isSystemTemporaryDescendant(normalizedCwd) },
			variables: new Map(),
		};
		await analyzeNode(document.root, context, state, document.control.check);
	} finally {
		document.dispose();
	}
	return true;
}

async function analyzeNode(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
	recordAssignment = false,
): Promise<void> {
	check();
	if (node.type === "command") {
		const command = commandUnit(node, context);
		pushUnit(state.units, command.unit);
		if (command.nestedScript !== undefined && !await parseScript(command.nestedScript, state.cwd, state.depth + 1, state.units)) {
			throw new BashUnitLimitError();
		}
		await analyzeEmbeddedShell(node, context, state, check);
		return;
	}
	if (node.type === "variable_assignment") {
		await analyzeEmbeddedShell(node, context, state, check);
		if (recordAssignment) recordStableAssignment(node, context, state.stableAssignments);
		return;
	}
	if (node.type === "file_redirect") {
		const redirect = redirectUnit(node, context, state.cwd);
		if (redirect !== undefined) pushUnit(state.units, redirect);
		await analyzeEmbeddedShell(node, context, state, check);
		return;
	}
	if (node.type === "program") {
		for (const child of node.namedChildren) {
			await analyzeNode(child, context, state, check, child.type === "variable_assignment");
		}
		return;
	}
	if (node.type === "for_statement") {
		await analyzeForStatement(node, context, state, check);
		return;
	}
	if (node.type === "list") {
		await analyzeList(node, context, state, check);
		return;
	}
	if (node.type === "redirected_statement") {
		let redirectContext = cloneContext(context);
		for (const child of node.namedChildren) {
			if (child.type === "list") {
				redirectContext = await analyzeList(child, redirectContext, state, check);
				continue;
			}
			await analyzeNode(child, redirectContext, state, check);
		}
		return;
	}
	if (node.type === "subshell" || node.type === "function_definition") {
		const nestedContext = cloneContext(context);
		for (const child of node.namedChildren) await analyzeNode(child, nestedContext, state, check);
		return;
	}
	for (const child of node.namedChildren) await analyzeNode(child, context, state, check);
}

async function analyzeForStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const variable = node.childForFieldName("variable")?.text;
	const body = node.childForFieldName("body");
	if (variable === undefined || body === null) {
		for (const child of node.namedChildren) await analyzeNode(child, cloneContext(context), state, check);
		return;
	}
	const values = node.childrenForFieldName("value").map((value) => resolveShellWord(value, context));
	if (values.length === 0 || values.some((value) => value === undefined)) {
		const unknownContext = cloneContext(context);
		unknownContext.variables.delete(variable);
		await analyzeNode(body, unknownContext, state, check);
		return;
	}
	for (const value of values) {
		if (value === undefined) continue;
		const iterationContext = cloneContext(context);
		iterationContext.variables.set(variable, value);
		await analyzeNode(body, iterationContext, state, check);
	}
}

async function analyzeList(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<BashAnalysisContext> {
	const base = cloneContext(context);
	let current = cloneContext(context);
	const children = node.namedChildren;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (child === undefined) continue;
		if (child.type === "list") current = await analyzeList(child, current, state, check);
		else await analyzeNode(child, current, state, check);
		const separator = separatorAfter(node, child, children[index + 1]);
		if (separator === "&&") {
			const nextCwd = successfulCdTarget(child, current);
			if (nextCwd !== undefined) current.cwd = nextCwd;
		} else if (separator !== undefined) {
			current = cloneContext(base);
		}
	}
	return current;
}

function separatorAfter(parent: SyntaxNode, current: SyntaxNode, next: SyntaxNode | undefined): string | undefined {
	if (next === undefined) return undefined;
	const start = parent.children.findIndex((child) => child.startIndex === current.startIndex && child.endIndex === current.endIndex);
	const end = parent.children.findIndex((child) => child.startIndex === next.startIndex && child.endIndex === next.endIndex);
	if (start < 0 || end < 0) return undefined;
	for (let index = start + 1; index < end; index += 1) {
		const text = parent.children[index]?.text;
		if (text === "&&" || text === "||" || text === ";" || text === "&") return text;
	}
	return undefined;
}

function successfulCdTarget(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type !== "command") return undefined;
	const name = node.childForFieldName("name");
	if (commandBasename(name === null ? undefined : literalNodeText(name)) !== "cd") return undefined;
	const args = node.childrenForFieldName("argument").map((argument) => resolveShellWord(argument, context));
	let destination: ResolvedShellValue | undefined;
	for (const argument of args) {
		if (argument === undefined) return undefined;
		if (argument.value === "--") continue;
		if (argument.value.startsWith("-")) return undefined;
		if (destination !== undefined) return undefined;
		destination = argument;
	}
	return destination === undefined ? undefined : resolvePath(destination, context.cwd, ".");
}

async function analyzeEmbeddedShell(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	for (const child of node.namedChildren) {
		if (child.type === "command_substitution" || child.type === "process_substitution") {
			for (const nested of child.namedChildren) await analyzeNode(nested, cloneContext(context), state, check);
			continue;
		}
		await analyzeEmbeddedShell(child, context, state, check);
	}
}

function stableAssignmentNames(root: SyntaxNode, check: () => void): ReadonlySet<string> {
	const counts = new Map<string, number>();
	for (const node of walkNamedNodes(root, check)) {
		if (node.type === "variable_assignment") {
			countVariableWrite(counts, node.childForFieldName("name")?.text);
			continue;
		}
		if (node.type === "for_statement" || node.type === "select_statement") {
			countVariableWrite(counts, node.childForFieldName("variable")?.text);
			continue;
		}
		if (node.type === "command") countCommandVariableWrites(counts, node);
	}
	return new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
}

function countCommandVariableWrites(counts: Map<string, number>, node: SyntaxNode): void {
	const nameNode = node.childForFieldName("name");
	const program = commandBasename(nameNode === null ? undefined : literalNodeText(nameNode));
	const args = node.childrenForFieldName("argument").map(literalNodeText);
	if (program === "read" || program === "readarray" || program === "mapfile" || program === "unset") {
		for (const argument of args) {
			if (argument !== undefined && !argument.startsWith("-")) countVariableWrite(counts, argument);
		}
		return;
	}
	if (program === "getopts") {
		countVariableWrite(counts, args[1]);
		return;
	}
	if (program !== "printf") return;
	const variableOption = args.findIndex((argument) => argument === "-v");
	if (variableOption >= 0) countVariableWrite(counts, args[variableOption + 1]);
}

function countVariableWrite(counts: Map<string, number>, name: string | undefined): void {
	if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return;
	counts.set(name, (counts.get(name) ?? 0) + 1);
}

function recordStableAssignment(
	node: SyntaxNode,
	context: BashAnalysisContext,
	stableAssignments: ReadonlySet<string>,
): void {
	const name = node.childForFieldName("name")?.text;
	if (name === undefined || !stableAssignments.has(name)) return;
	const valueNode = node.childForFieldName("value");
	if (valueNode === null) {
		context.variables.delete(name);
		return;
	}
	const value = temporaryPathAssignment(valueNode, context) ?? resolveShellWord(valueNode, context);
	if (value === undefined) context.variables.delete(name);
	else context.variables.set(name, value);
}

function temporaryPathAssignment(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type === "string" && node.namedChildren.length === 1) {
		const child = node.namedChildren[0];
		return child?.type === "command_substitution" ? temporaryPathAssignment(child, context) : undefined;
	}
	if (node.type !== "command_substitution") return undefined;
	const commands = [...walkNamedNodes(node, () => {})].filter((candidate) => candidate.type === "command");
	if (commands.length !== 1) return undefined;
	const command = commands[0];
	if (command === undefined) return undefined;
	const name = command.childForFieldName("name");
	if (commandBasename(name === null ? undefined : literalNodeText(name)) !== "mktemp") return undefined;
	const args = command.childrenForFieldName("argument").map((argument) => resolveShellWord(argument, context)?.value);
	if (args.some((argument) => argument === undefined)) return undefined;
	const values = args as string[];
	if (values.length === 0) return { value: TEMPORARY_FILE_PATH, temporary: true };
	if (values.length === 1 && (values[0] === "-d" || values[0] === "--directory")) {
		return { value: TEMPORARY_DIRECTORY_PATH, temporary: true };
	}
	return undefined;
}

function cloneContext(context: BashAnalysisContext): BashAnalysisContext {
	return {
		cwd: { ...context.cwd },
		variables: new Map([...context.variables].map(([name, value]) => [name, { ...value }])),
	};
}

function* walkNamedNodes(root: SyntaxNode, check: () => void): Generator<SyntaxNode> {
	const stack = [root];
	while (stack.length > 0) {
		check();
		const node = stack.pop();
		if (node === undefined) break;
		yield node;
		for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
			const child = node.namedChildren[index];
			if (child !== undefined) stack.push(child);
		}
	}
}

function commandUnit(node: SyntaxNode, context: BashAnalysisContext): { unit: ApprovalUnit; nestedScript?: string } {
	const nameNode = node.childForFieldName("name");
	const argumentNodes = node.childrenForFieldName("argument");
	const literalProgram = nameNode === null ? undefined : literalNodeText(nameNode);
	const literalArgs = argumentNodes.map(literalNodeText);
	const program = literalProgram ?? (nameNode === null ? undefined : resolveShellWord(nameNode, context)?.value);
	const args = argumentNodes.map((argument, index) => literalArgs[index] ?? resolveShellWord(argument, context)?.value);
	const contextResolved = (literalProgram === undefined && program !== undefined)
		|| args.some((argument, index) => literalArgs[index] === undefined && argument !== undefined);
	const rawFacts = { program: commandBasename(program), args };
	const facts = unwrapCommand(rawFacts);
	const nestedScript = shellScript(effectiveCommand(facts));
	const exactValue = normalizeCommandNode(node);
	const matchValue = commandView(rawFacts);
	const similarValue = commandView(facts);
	const temporary = commandEffectsStayTemporary(facts, context.cwd);
	return {
		unit: {
			action: "execute",
			target: {
				kind: "command",
				value: exactValue,
				match_value: matchValue,
				...(similarValue === matchValue ? {} : { similar_value: similarValue }),
			},
			...(temporary ? { effect_scope: "temporary" as const } : {}),
			remember: {
				session: !contextResolved,
				persistent: !contextResolved && isRememberableCommand(facts, nestedScript !== undefined),
			},
		},
		...(nestedScript === undefined ? {} : { nestedScript }),
	};
}

function redirectUnit(node: SyntaxNode, context: BashAnalysisContext, cwd: string): ApprovalUnit | undefined {
	const operator = node.children.find((child) => !child.isNamed)?.text;
	if (operator === undefined || !writesFile(operator, node)) return undefined;
	const destination = node.childForFieldName("destination");
	if (destination === null) return dynamicRedirectUnit(node);
	if (destination.type === "process_substitution") return undefined;
	const resolved = resolveShellWord(destination, context);
	if (resolved === undefined) return dynamicRedirectUnit(node);
	if (operator === ">&" && (resolved.value === "-" || /^\d+$/u.test(resolved.value))) return undefined;
	const target = resolvePath(resolved, context.cwd, cwd);
	if (target === undefined) return dynamicRedirectUnit(node);
	return {
		action: "write_redirect",
		target: { kind: "path", value: displayTemporaryPath(target.value) },
		...(target.temporary ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
}

function dynamicRedirectUnit(node: SyntaxNode): ApprovalUnit {
	const value = normalizeSource(node.text);
	return {
		action: "write_redirect",
		target: { kind: "command", value, match_value: `<dynamic> ${value}` },
		remember: { session: false, persistent: false },
	};
}

function writesFile(operator: string, node: SyntaxNode): boolean {
	if (operator === ">" || operator === ">>" || operator === ">|" || operator === "&>" || operator === "&>>") return true;
	if (operator === ">&") return node.childForFieldName("descriptor") === null;
	return false;
}

function commandEffectsStayTemporary(facts: CommandFacts, cwd: ResolvedShellValue): boolean {
	if (facts.program === "rm" || facts.program === "rmdir") {
		const operands = commandOperands(facts.args);
		return operands.length > 0 && operands.every((operand) => {
			if (operand === undefined) return false;
			const temporary = isSyntheticTemporaryPath(operand);
			return resolvePath({ value: operand, temporary }, cwd, ".")?.temporary === true;
		});
	}
	if (!cwd.temporary || facts.args.some((argument) => argument === undefined) || facts.program !== "git") return false;
	const args = facts.args as string[];
	if (args.some((argument) => argument === "-C" || argument.startsWith("--git-dir") || argument.startsWith("--work-tree"))) {
		return false;
	}
	return args[0] === "clean" || (args[0] === "reset" && args.includes("--hard"));
}

function commandOperands(args: Array<string | undefined>): Array<string | undefined> {
	const operands: Array<string | undefined> = [];
	let optionsEnded = false;
	for (const argument of args) {
		if (!optionsEnded && argument === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && argument?.startsWith("-") === true && argument !== "-") continue;
		operands.push(argument);
	}
	return operands;
}

function resolvePath(
	input: ResolvedShellValue,
	cwd: ResolvedShellValue,
	fallbackCwd: string,
): ResolvedShellValue | undefined {
	if (input.temporary && isSyntheticTemporaryValue(input.value)) return normalizeSyntheticTemporaryPath(input.value);
	if (path.isAbsolute(input.value)) {
		return resolvedConcretePath(input.value, fallbackCwd);
	}
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

function systemTemporaryRoots(): readonly string[] {
	const roots = new Set<string>();
	if (process.platform === "win32") {
		roots.add(normalizeTargetPath(os.tmpdir(), path.parse(os.tmpdir()).root));
	} else {
		for (const root of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) {
			roots.add(normalizeTargetPath(root, "/"));
		}
		const runtimeRoot = normalizeTargetPath(os.tmpdir(), "/");
		if (process.platform === "darwin" && runtimeRoot.startsWith("/var/folders/")) roots.add(runtimeRoot);
	}
	return [...roots];
}

function isSystemTemporaryDescendant(value: string): boolean {
	const target = comparablePath(value);
	return SYSTEM_TEMPORARY_ROOTS.some((root) => {
		const comparableRoot = comparablePath(root);
		return target !== comparableRoot && target.startsWith(`${comparableRoot}/`);
	});
}

function comparablePath(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/u, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

function isSyntheticTemporaryPath(value: string): boolean {
	return value === TEMPORARY_FILE_PATH || isSyntheticTemporaryDirectory(value);
}

function isSyntheticTemporaryValue(value: string): boolean {
	return value.startsWith(TEMPORARY_FILE_PATH) || value.startsWith(TEMPORARY_DIRECTORY_PATH);
}

function isSyntheticTemporaryDirectory(value: string): boolean {
	return value === TEMPORARY_DIRECTORY_PATH || value.startsWith(`${TEMPORARY_DIRECTORY_PATH}/`);
}

function displayTemporaryPath(value: string): string {
	if (value === TEMPORARY_FILE_PATH) return TEMPORARY_PATH_DISPLAY;
	return isSyntheticTemporaryDirectory(value)
		? `${TEMPORARY_PATH_DISPLAY}${value.slice(TEMPORARY_DIRECTORY_PATH.length)}`
		: value;
}

function resolveShellWord(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type === "command_substitution") return temporaryPathAssignment(node, context);
	return resolveShellToken(node.text, context);
}

function resolveShellToken(source: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
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
		const character = source[index];
		if (character === undefined) break;
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
			const expansion = resolveVariableExpansion(source, index, context);
			if (expansion === undefined || !append(expansion.value)) return undefined;
			index = expansion.end;
			continue;
		}
		if (character === "`") return undefined;
		if (quote === undefined && (character === "*" || character === "?" || character === "[" || character === "{")) return undefined;
		if (quote === undefined && character === "~" && index === 0) return undefined;
		result += character;
	}
	if (quote !== undefined) return undefined;
	if (!temporary) return { value: result, temporary: false };
	return normalizeSyntheticTemporaryPath(result);
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
		const name = source.slice(start + 2, end);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
		const value = variableValue(name, context);
		return value === undefined ? undefined : { value, end };
	}
	const match = source.slice(start + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
	const name = match?.[0];
	if (name === undefined) return undefined;
	const value = variableValue(name, context);
	return value === undefined ? undefined : { value, end: start + name.length };
}

function variableValue(name: string, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (name === "PWD") return { ...context.cwd };
	const value = context.variables.get(name);
	return value === undefined ? undefined : { ...value };
}

function isRememberableCommand(facts: CommandFacts, parsedLiteralShell: boolean, depth = 0): boolean {
	const program = facts.program;
	if (program === undefined) return false;
	if (program === "sudo") {
		if (depth >= 8) return false;
		const nested = unwrapCommand(commandAfterOptions(facts.args, SUDO_OPTIONS_WITH_VALUE, true));
		return isRememberableCommand(nested, parsedLiteralShell, depth + 1);
	}
	if (program === "eval") return false;
	return !SHELL_PROGRAMS.has(program) || shellCommandIndex(facts.args) === undefined || parsedLiteralShell;
}

function unwrapCommand(input: CommandFacts): CommandFacts {
	let facts = input;
	for (let depth = 0; depth < 8; depth += 1) {
		const program = facts.program;
		if (program === undefined) return facts;
		if (program === "env") {
			facts = commandAfterEnv(facts.args);
			continue;
		}
		if (program === "builtin" || program === "command" || program === "exec" || program === "nohup" || program === "time") {
			facts = commandAfterOptions(facts.args, NO_OPTIONS_WITH_VALUE);
			continue;
		}
		return facts;
	}
	return { ...facts, program: undefined };
}

function effectiveCommand(facts: CommandFacts): CommandFacts {
	let current = facts;
	for (let depth = 0; depth < 8 && current.program === "sudo"; depth += 1) {
		current = unwrapCommand(commandAfterOptions(current.args, SUDO_OPTIONS_WITH_VALUE, true));
	}
	return current.program === "sudo" ? { ...current, program: undefined } : current;
}

function commandAfterEnv(args: Array<string | undefined>): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (value === undefined) return { program: undefined, args: args.slice(index + 1) };
		if (value === "--") {
			index += 1;
			break;
		}
		if (value === "-S" || value === "--split-string" || value.startsWith("--split-string=")) {
			return { program: undefined, args: args.slice(index + 1) };
		}
		if (value === "-u" || value === "--unset" || value === "-C" || value === "--chdir") {
			index += 2;
			continue;
		}
		if (value.startsWith("--unset=") || value.startsWith("--chdir=")) {
			index += 1;
			continue;
		}
		if (value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
			index += 1;
			continue;
		}
		break;
	}
	return { program: commandBasename(args[index]), args: args.slice(index + 1) };
}

function commandAfterOptions(
	args: Array<string | undefined>,
	optionsWithValue: ReadonlySet<string>,
	skipAssignments = false,
): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (value === undefined) return { program: undefined, args: args.slice(index + 1) };
		if (value === "--") {
			index += 1;
			break;
		}
		if (skipAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
			index += 1;
			continue;
		}
		if (!value.startsWith("-") || value === "-") break;
		const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
		index += optionsWithValue.has(option) && !value.includes("=") ? 2 : 1;
	}
	return { program: commandBasename(args[index]), args: args.slice(index + 1) };
}

function shellScript(facts: CommandFacts): string | undefined {
	if (facts.program === undefined || !SHELL_PROGRAMS.has(facts.program)) return undefined;
	const index = shellCommandIndex(facts.args);
	return index === undefined ? undefined : facts.args[index + 1];
}

function shellCommandIndex(args: Array<string | undefined>): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value === "-c" || (value?.startsWith("-") === true && !value.startsWith("--") && value.slice(1).includes("c"))) return index;
	}
	return undefined;
}

function commandView(facts: CommandFacts): string {
	return [
		facts.program ?? "<dynamic>",
		...facts.args.map((value) => value === undefined ? "<dynamic>" : displayTemporaryPath(value)),
	].join(" ");
}

function normalizeCommandNode(node: SyntaxNode): string {
	const parts = node.namedChildren
		.filter((child) => child.type !== "file_redirect" && child.type !== "heredoc_redirect" && child.type !== "herestring_redirect")
		.map((child) => normalizeSource(child.text))
		.filter((part) => part.length > 0);
	return parts.length === 0 ? normalizeSource(node.text) : parts.join(" ");
}

function literalNodeText(node: SyntaxNode): string | undefined {
	if (containsDynamicShellNode(node)) return undefined;
	return decodeStaticShellWord(node.text);
}

function normalizeSource(value: string): string {
	let result = "";
	let quote: "'" | "\"" | undefined;
	let pendingSpace = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === undefined) break;
		if (quote !== undefined) {
			result += character;
			if (quote === "\"" && character === "\\") {
				const next = value[index + 1];
				if (next !== undefined) {
					result += next;
					index += 1;
				}
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (/\s/u.test(character)) {
			pendingSpace = result.length > 0;
			continue;
		}
		if (pendingSpace) {
			result += " ";
			pendingSpace = false;
		}
		result += character;
		if (character === "'" || character === "\"") quote = character;
		else if (character === "\\") {
			const next = value[index + 1];
			if (next !== undefined) {
				result += next;
				index += 1;
			}
		}
	}
	return result;
}

function commandBasename(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function pushUnit(units: ApprovalUnit[], unit: ApprovalUnit): void {
	if (units.length >= MAX_BASH_UNITS) throw new BashUnitLimitError();
	units.push(unit);
}
