import path from "node:path";

import { containsDynamicShellNode, decodeStaticShellWord } from "../syntax-tree/bash.js";
import { getTreeSitterLanguage } from "../syntax-tree/grammars.js";
import { parseSyntaxTree } from "../syntax-tree/parser.js";
import type { SyntaxNode } from "../syntax-tree/types.js";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "./path.js";
import type { ApprovalUnit } from "./types.js";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
// NUL 不可能出现在 shell 参数中，用作不可由输入伪造的内部路径根。
const TEMPORARY_DIRECTORY_PATH = "\0temporary-directory";
const TEMPORARY_FILE_PATH = "\0temporary-file";
const TEMPORARY_PATH_DISPLAY = "<temporary>";
const UNKNOWN_DIRECTORY_PATH = "\0unknown-directory";
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
	exitTraps: Set<string>;
}

interface ShellFunction {
	body: SyntaxNode;
}

interface NestedShell {
	script: string;
	positional: Map<string, ResolvedShellValue>;
}

interface ParsedCommand {
	unit: ApprovalUnit;
	rawFacts: CommandFacts;
	nestedShell?: NestedShell;
}

interface BashAnalysisState {
	fallbackCwd: string;
	depth: number;
	units: ApprovalUnit[];
	functions: ReadonlyMap<string, readonly ShellFunction[]>;
	activeFunctions: Set<string>;
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

async function parseScript(
	script: string,
	cwd: string,
	depth: number,
	units: ApprovalUnit[],
	initialContext?: BashAnalysisContext,
	inheritedFunctions?: ReadonlyMap<string, readonly ShellFunction[]>,
): Promise<boolean> {
	if (depth > MAX_NESTED_SHELL_DEPTH) throw new BashUnitLimitError();
	const document = await parseSyntaxTree(BASH_GRAMMAR, script);
	if (document === undefined) return false;
	try {
		if (document.root.hasError) return false;
		const state: BashAnalysisState = {
			fallbackCwd: cwd,
			depth,
			units,
			functions: mergeFunctions(inheritedFunctions, collectFunctions(document.root, document.control.check)),
			activeFunctions: new Set(),
		};
		const normalizedCwd = normalizeTargetPath(".", cwd);
		const context = initialContext === undefined
			? {
				cwd: { value: normalizedCwd, temporary: isSystemTemporaryDescendant(normalizedCwd) },
				variables: new Map<string, ResolvedShellValue>(),
				exitTraps: new Set<string>(),
			}
			: cloneContext(initialContext);
		await analyzeNode(document.root, context, state, document.control.check);
		await analyzeExitTraps(context, state, document.control.check);
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
): Promise<void> {
	check();
	if (node.type === "command") {
		const cdTarget = successfulCdTarget(node, context);
		const command = commandUnit(node, context);
		pushUnit(state.units, command.unit);
		if (command.nestedShell !== undefined) {
			const nestedContext: BashAnalysisContext = {
				cwd: { ...context.cwd },
				variables: new Map(command.nestedShell.positional),
				exitTraps: new Set(),
			};
			if (!await parseScript(
				command.nestedShell.script,
				state.fallbackCwd,
				state.depth + 1,
				state.units,
				nestedContext,
			)) throw new BashUnitLimitError();
		}
		await analyzeEmbeddedShell(node, context, state, check);
		handleExitTrap(command.rawFacts, context);
		await analyzeFunctionCall(command.rawFacts, context, state, check);
		invalidateCommandVariables(command.rawFacts, context);
		if (cdTarget !== undefined) context.cwd = { value: UNKNOWN_DIRECTORY_PATH, temporary: false };
		return;
	}
	if (node.type === "variable_assignment") {
		await analyzeEmbeddedShell(node, context, state, check);
		recordAssignment(node, context);
		return;
	}
	if (node.type === "file_redirect") {
		const redirect = redirectUnit(node, context, state.fallbackCwd);
		if (redirect !== undefined) pushUnit(state.units, redirect);
		await analyzeEmbeddedShell(node, context, state, check);
		return;
	}
	if (node.type === "function_definition") return;
	if (node.type === "if_statement") {
		await analyzeIfStatement(node, context, state, check);
		return;
	}
	if (node.type === "case_statement") {
		await analyzeCaseStatement(node, context, state, check);
		return;
	}
	if (node.type === "for_statement") {
		await analyzeForStatement(node, context, state, check);
		return;
	}
	if (node.type === "while_statement" || node.type === "until_statement" || node.type === "select_statement") {
		await analyzeUncertainLoop(node, context, state, check);
		return;
	}
	if (node.type === "list") {
		const result = await analyzeList(node, context, state, check);
		assignContext(context, result);
		return;
	}
	if (node.type === "redirected_statement") {
		let redirectContext = cloneContext(context);
		for (const child of node.namedChildren) {
			if (child.type === "list") redirectContext = await analyzeList(child, redirectContext, state, check, false);
			else await analyzeNode(child, redirectContext, state, check);
		}
		return;
	}
	if (node.type === "subshell") {
		const nestedContext = cloneContext(context);
		for (const child of node.namedChildren) await analyzeNode(child, nestedContext, state, check);
		return;
	}
	for (const child of node.namedChildren) await analyzeNode(child, context, state, check);
}

async function analyzeIfStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const condition = node.childForFieldName("condition");
	if (condition !== null) await analyzeNode(condition, context, state, check);
	const branchBase = cloneContext(context);
	const branches: BashAnalysisContext[] = [];
	const consequence = node.namedChildren.filter((child) =>
		(condition === null || !sameSyntaxNode(child, condition))
		&& child.type !== "elif_clause" && child.type !== "else_clause");
	if (consequence.length > 0) {
		const branch = cloneContext(branchBase);
		for (const child of consequence) await analyzeNode(child, branch, state, check);
		branches.push(branch);
	}
	for (const clause of node.namedChildren.filter((child) => child.type === "elif_clause")) {
		const branch = cloneContext(branchBase);
		for (const child of clause.namedChildren) await analyzeNode(child, branch, state, check);
		branches.push(branch);
	}
	const alternative = node.namedChildren.find((child) => child.type === "else_clause");
	if (alternative === undefined) branches.push(branchBase);
	else {
		const branch = cloneContext(branchBase);
		for (const child of alternative.namedChildren) await analyzeNode(child, branch, state, check);
		branches.push(branch);
	}
	assignContext(context, joinContexts(branches));
}

function sameSyntaxNode(left: SyntaxNode, right: SyntaxNode): boolean {
	return left.startIndex === right.startIndex && left.endIndex === right.endIndex && left.type === right.type;
}

async function analyzeCaseStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const subject = node.childForFieldName("value") ?? node.namedChildren.find((child) => child.type !== "case_item");
	if (subject !== undefined && subject !== null) await analyzeEmbeddedShell(subject, context, state, check);
	const branches: BashAnalysisContext[] = [];
	let exhaustive = false;
	for (const item of node.namedChildren.filter((child) => child.type === "case_item")) {
		const branch = cloneContext(context);
		for (const child of item.namedChildren) {
			if (child.type === "word" || child.type === "extglob_pattern") {
				if (child.text === "*") exhaustive = true;
				continue;
			}
			await analyzeNode(child, branch, state, check);
		}
		branches.push(branch);
	}
	if (!exhaustive) branches.push(cloneContext(context));
	if (branches.length > 0) assignContext(context, joinContexts(branches));
}

async function analyzeUncertainLoop(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const iteration = cloneContext(context);
	for (const child of node.namedChildren) await analyzeNode(child, iteration, state, check);
	mergeUncertainEffects(context, [iteration]);
	invalidateAssignedVariables(node, context, check);
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
		const iteration = cloneContext(context);
		for (const child of node.namedChildren) await analyzeNode(child, iteration, state, check);
		mergeUncertainEffects(context, [iteration]);
		invalidateAssignedVariables(node, context, check);
		return;
	}
	const values = node.childrenForFieldName("value").map((value) => resolveShellWord(value, context, false, true));
	if (values.length === 0 || values.some((value) => value === undefined)) {
		const unknownContext = cloneContext(context);
		unknownContext.variables.delete(variable);
		await analyzeNode(body, unknownContext, state, check);
		mergeUncertainEffects(context, [unknownContext]);
		context.variables.delete(variable);
		invalidateAssignedVariables(body, context, check);
		return;
	}
	const iterations: BashAnalysisContext[] = [];
	for (const value of values) {
		if (value === undefined) continue;
		const iterationContext = cloneContext(context);
		iterationContext.variables.set(variable, value);
		await analyzeNode(body, iterationContext, state, check);
		iterations.push(iterationContext);
	}
	mergeUncertainEffects(context, iterations);
	context.variables.delete(variable);
	invalidateAssignedVariables(body, context, check);
}

function mergeUncertainEffects(context: BashAnalysisContext, outcomes: readonly BashAnalysisContext[]): void {
	const possible = [cloneContext(context), ...outcomes];
	context.cwd = joinValues(possible.map((outcome) => outcome.cwd))
		?? { value: UNKNOWN_DIRECTORY_PATH, temporary: false };
	context.exitTraps = new Set(possible.flatMap((outcome) => [...outcome.exitTraps]));
}

async function analyzeList(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
	joinOutcome = true,
): Promise<BashAnalysisContext> {
	let current = cloneContext(context);
	const outcomes: BashAnalysisContext[] = [];
	const children = node.namedChildren;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (child === undefined) continue;
		const before = cloneContext(current);
		const cdTarget = successfulCdTarget(child, current);
		if (child.type === "list") current = await analyzeList(child, current, state, check, false);
		else await analyzeNode(child, current, state, check);
		const separator = separatorAfter(node, child, children[index + 1]);
		if (separator === "&&") {
			outcomes.push(before);
			if (cdTarget !== undefined) current.cwd = cdTarget;
		} else if (separator === "||") {
			const success = cloneContext(current);
			if (cdTarget !== undefined) success.cwd = cdTarget;
			outcomes.push(success);
			current = before;
		} else if (separator === "&") current = before;
		else if (separator === ";" && cdTarget !== undefined) current.cwd = before.cwd;
	}
	return joinOutcome && outcomes.length > 0 ? joinContexts([current, ...outcomes]) : current;
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
	const raw = commandFacts(node, context);
	if (raw.program !== "cd" && raw.program !== "command" && raw.program !== "builtin") return undefined;
	const facts = raw.program === "cd" ? raw : unwrapCommand(raw);
	if (facts.program !== "cd") return undefined;
	let destination: ResolvedShellValue | undefined;
	for (const value of facts.args) {
		if (value === undefined) return undefined;
		if (value === "--") continue;
		if (value.startsWith("-")) return undefined;
		if (destination !== undefined) return undefined;
		destination = { value, temporary: isSyntheticTemporaryPath(value) };
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

function mergeFunctions(
	inherited: ReadonlyMap<string, readonly ShellFunction[]> | undefined,
	local: ReadonlyMap<string, readonly ShellFunction[]>,
): ReadonlyMap<string, readonly ShellFunction[]> {
	if (inherited === undefined) return local;
	const merged = new Map(inherited);
	for (const [name, definitions] of local) merged.set(name, [...(merged.get(name) ?? []), ...definitions]);
	return merged;
}

function collectFunctions(root: SyntaxNode, check: () => void): ReadonlyMap<string, readonly ShellFunction[]> {
	const functions = new Map<string, ShellFunction[]>();
	for (const node of walkNamedNodes(root, check)) {
		if (node.type !== "function_definition") continue;
		const name = node.childForFieldName("name")?.text ?? node.namedChildren[0]?.text;
		const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type === "compound_statement");
		if (name !== undefined && body !== undefined) {
			const definitions = functions.get(name) ?? [];
			definitions.push({ body });
			functions.set(name, definitions);
		}
	}
	return functions;
}

function recordAssignment(node: SyntaxNode, context: BashAnalysisContext): void {
	const name = node.childForFieldName("name")?.text;
	if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !node.text.startsWith(`${name}=`)) {
		if (name !== undefined) context.variables.delete(name);
		return;
	}
	const valueNode = node.childForFieldName("value");
	if (valueNode === null) {
		context.variables.set(name, { value: "", temporary: false });
		return;
	}
	const value = temporaryPathAssignment(valueNode, context) ?? resolveShellWord(valueNode, context, true, true);
	if (value === undefined) context.variables.delete(name);
	else context.variables.set(name, value);
}

function invalidateCommandVariables(facts: CommandFacts, context: BashAnalysisContext): void {
	const program = facts.program;
	if (program === "read" || program === "readarray" || program === "mapfile" || program === "unset") {
		for (const argument of facts.args) {
			if (argument !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(argument)) context.variables.delete(argument);
		}
		return;
	}
	if (program === "getopts") {
		const name = facts.args[1];
		if (name !== undefined) context.variables.delete(name);
		return;
	}
	if (program !== "printf") return;
	const variableOption = facts.args.findIndex((argument) => argument === "-v");
	const name = facts.args[variableOption + 1];
	if (variableOption >= 0 && name !== undefined) context.variables.delete(name);
}

function invalidateAssignedVariables(node: SyntaxNode, context: BashAnalysisContext, check: () => void): void {
	for (const candidate of walkNamedNodesSkippingFunctions(node, check)) {
		if (candidate.type === "variable_assignment") {
			const name = candidate.childForFieldName("name")?.text;
			if (name !== undefined) context.variables.delete(name);
			continue;
		}
		if (candidate.type === "for_statement" || candidate.type === "select_statement") {
			const name = candidate.childForFieldName("variable")?.text;
			if (name !== undefined) context.variables.delete(name);
			continue;
		}
		if (candidate.type === "command") invalidateCommandVariables(commandFacts(candidate, context), context);
	}
}

async function analyzeFunctionCall(
	facts: CommandFacts,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const name = facts.program;
	const definitions = name === undefined ? undefined : state.functions.get(name);
	if (name === undefined || definitions === undefined || state.activeFunctions.has(name)) return;
	state.activeFunctions.add(name);
	try {
		const trapOutcomes: Set<string>[] = [];
		for (const definition of definitions) {
			const functionContext = cloneContext(context);
			setPositionalVariables(functionContext.variables, facts.args);
			await analyzeNode(definition.body, functionContext, state, check);
			invalidateAssignedVariables(definition.body, context, check);
			trapOutcomes.push(functionContext.exitTraps);
		}
		context.exitTraps = new Set(trapOutcomes.flatMap((traps) => [...traps]));
	} finally {
		state.activeFunctions.delete(name);
	}
}

function handleExitTrap(facts: CommandFacts, context: BashAnalysisContext): void {
	if (facts.program !== "trap" || facts.args.length < 2) return;
	const action = facts.args[0];
	if (action === undefined || !facts.args.slice(1).some((signal) => signal === "EXIT" || signal === "0")) return;
	context.exitTraps.clear();
	if (action !== "-") context.exitTraps.add(action);
}

async function analyzeExitTraps(
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	for (const action of [...context.exitTraps]) {
		if (state.functions.has(action)) {
			await analyzeFunctionCall({ program: action, args: [] }, context, state, check);
			continue;
		}
		const trapContext = cloneContext(context);
		trapContext.exitTraps.clear();
		if (!await parseScript(action, state.fallbackCwd, state.depth + 1, state.units, trapContext, state.functions)) {
			throw new BashUnitLimitError();
		}
	}
}

function setPositionalVariables(
	variables: Map<string, ResolvedShellValue>,
	args: Array<string | undefined>,
): void {
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value !== undefined) variables.set(String(index + 1), shellArgumentValue(value));
	}
}

function shellArgumentValue(value: string): ResolvedShellValue {
	return { value, temporary: isSyntheticTemporaryPath(value) };
}

function assignContext(target: BashAnalysisContext, source: BashAnalysisContext): void {
	target.cwd = { ...source.cwd };
	target.variables = new Map([...source.variables].map(([name, value]) => [name, { ...value }]));
	target.exitTraps = new Set(source.exitTraps);
}

function joinContexts(contexts: readonly BashAnalysisContext[]): BashAnalysisContext {
	const first = contexts[0];
	if (first === undefined) throw new Error("cannot join an empty Bash context set");
	const variables = new Map<string, ResolvedShellValue>();
	for (const [name] of first.variables) {
		const values = contexts.map((context) => context.variables.get(name));
		if (values.some((value) => value === undefined)) continue;
		const joined = joinValues(values as ResolvedShellValue[]);
		if (joined !== undefined) variables.set(name, joined);
	}
	return {
		cwd: joinValues(contexts.map((context) => context.cwd)) ?? { value: UNKNOWN_DIRECTORY_PATH, temporary: false },
		variables,
		exitTraps: new Set(contexts.flatMap((context) => [...context.exitTraps])),
	};
}

function joinValues(values: readonly ResolvedShellValue[]): ResolvedShellValue | undefined {
	const first = values[0];
	if (first === undefined) return undefined;
	if (values.every((value) => value.value === first.value && value.temporary === first.temporary)) return { ...first };
	if (values.every(isDefinitelyTemporaryPath)) return { value: TEMPORARY_DIRECTORY_PATH, temporary: true };
	return undefined;
}

function isDefinitelyTemporaryPath(value: ResolvedShellValue): boolean {
	if (isSyntheticTemporaryPath(value.value)) return true;
	return path.isAbsolute(value.value) && isSystemTemporaryDescendant(normalizeTargetPath(value.value, "/"));
}

function temporaryPathAssignment(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type === "string" && node.namedChildren.length === 1) {
		const child = node.namedChildren[0];
		return child?.type === "command_substitution" && node.text === `"${child.text}"`
			? temporaryPathAssignment(child, context)
			: undefined;
	}
	if (node.type !== "command_substitution") return undefined;
	const commands = [...walkNamedNodes(node, () => {})].filter((candidate) => candidate.type === "command");
	if (commands.length !== 1) return undefined;
	const command = commands[0];
	if (command === undefined) return undefined;
	const facts = unwrapCommand(commandFacts(command, context));
	if (facts.program !== "mktemp" || facts.args.some((argument) => argument === undefined)) return undefined;
	const directory = mktempDirectoryMode(facts.args as string[]);
	if (directory === undefined) return undefined;
	return {
		value: directory ? TEMPORARY_DIRECTORY_PATH : TEMPORARY_FILE_PATH,
		temporary: true,
	};
}

function mktempDirectoryMode(args: readonly string[]): boolean | undefined {
	let directory = false;
	let positional = 0;
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) return undefined;
		if (optionsEnded || !argument.startsWith("-") || argument === "-") {
			positional += 1;
			if (positional > 1) return undefined;
			continue;
		}
		if (argument === "--") {
			optionsEnded = true;
			continue;
		}
		if (argument === "--directory") {
			directory = true;
			continue;
		}
		if (argument === "--quiet" || argument === "--tmpdir" || argument.startsWith("--tmpdir=")) continue;
		if (argument === "--dry-run" || (argument === "--suffix" && args[index + 1] === undefined)) return undefined;
		if (argument.startsWith("--suffix=")) continue;
		if (argument === "--suffix") {
			index += 1;
			continue;
		}
		if (argument.startsWith("--")) return undefined;
		const options = argument.slice(1);
		for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
			const option = options[optionIndex];
			if (option === "d") directory = true;
			else if (option === "q") continue;
			else if (option === "u" || option === "t") return undefined;
			else if (option === "p") {
				if (optionIndex + 1 < options.length) break;
				if (args[index + 1] === undefined) return undefined;
				index += 1;
				break;
			} else return undefined;
		}
	}
	return directory;
}

function cloneContext(context: BashAnalysisContext): BashAnalysisContext {
	return {
		cwd: { ...context.cwd },
		variables: new Map([...context.variables].map(([name, value]) => [name, { ...value }])),
		exitTraps: new Set(context.exitTraps),
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

function* walkNamedNodesSkippingFunctions(root: SyntaxNode, check: () => void): Generator<SyntaxNode> {
	const stack = [root];
	while (stack.length > 0) {
		check();
		const node = stack.pop();
		if (node === undefined) break;
		yield node;
		if (node !== root && node.type === "function_definition") continue;
		for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
			const child = node.namedChildren[index];
			if (child !== undefined) stack.push(child);
		}
	}
}

function commandUnit(node: SyntaxNode, context: BashAnalysisContext): ParsedCommand {
	const nameNode = node.childForFieldName("name");
	const argumentNodes = node.childrenForFieldName("argument");
	const literalProgram = nameNode === null ? undefined : literalNodeText(nameNode);
	const literalArgs = argumentNodes.map(literalNodeText);
	const program = literalProgram ?? (nameNode === null ? undefined : resolveShellWord(nameNode, context)?.value);
	const args = argumentNodes.map((argument, index) => literalArgs[index] ?? resolveShellWord(argument, context, false, true)?.value);
	const contextResolved = (literalProgram === undefined && program !== undefined)
		|| args.some((argument, index) => literalArgs[index] === undefined && argument !== undefined);
	const rawFacts = { program: commandBasename(program), args };
	const facts = unwrapCommand(rawFacts);
	const nestedShell = shellInvocation(effectiveCommand(facts));
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
				persistent: !contextResolved && isRememberableCommand(facts, nestedShell !== undefined),
			},
		},
		rawFacts,
		...(nestedShell === undefined ? {} : { nestedShell }),
	};
}

function commandFacts(node: SyntaxNode, context: BashAnalysisContext): CommandFacts {
	const nameNode = node.childForFieldName("name");
	const program = nameNode === null ? undefined : literalNodeText(nameNode) ?? resolveShellWord(nameNode, context)?.value;
	const args = node.childrenForFieldName("argument").map((argument) =>
		literalNodeText(argument) ?? resolveShellWord(argument, context, false, true)?.value);
	return { program: commandBasename(program), args };
}

function redirectUnit(node: SyntaxNode, context: BashAnalysisContext, cwd: string): ApprovalUnit | undefined {
	const operator = node.children.find((child) => !child.isNamed)?.text;
	if (operator === undefined || !writesFile(operator, node)) return undefined;
	const destination = node.childForFieldName("destination");
	if (destination === null) return dynamicRedirectUnit(node);
	if (destination.type === "process_substitution") return undefined;
	const resolved = resolveShellWord(destination, context, false, true);
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
		if (facts.program === "rmdir" && hasRmdirParentsOption(facts.args)) return false;
		const operands = commandOperands(facts.args);
		return operands.length > 0 && operands.every((operand) => {
			if (operand === undefined) return false;
			const temporary = isSyntheticTemporaryPath(operand);
			return resolvePath({ value: operand, temporary }, cwd, ".")?.temporary === true;
		});
	}
	if (facts.program !== "git" || facts.args.some((argument) => argument === undefined)) return false;
	const invocation = temporaryGitInvocation(facts.args as string[], cwd);
	return invocation !== undefined
		&& (invocation.command === "clean" || invocation.command === "reset" && invocation.args.includes("--hard"));
}

function hasRmdirParentsOption(args: Array<string | undefined>): boolean {
	return args.some((argument) => argument === "--parents"
		|| (argument?.startsWith("-") === true && !argument.startsWith("--") && argument.slice(1).includes("p")));
}

function temporaryGitInvocation(
	args: readonly string[],
	initialCwd: ResolvedShellValue,
): { command: string; args: string[] } | undefined {
	let cwd = { ...initialCwd };
	let index = 0;
	while (index < args.length) {
		const argument = args[index];
		if (argument === undefined) return undefined;
		if (argument === "-C") {
			const destination = args[index + 1];
			if (destination === undefined) return undefined;
			const resolved = resolvePath(shellArgumentValue(destination), cwd, ".");
			if (resolved === undefined) return undefined;
			cwd = resolved;
			index += 2;
			continue;
		}
		if (argument === "--git-dir" || argument === "--work-tree"
			|| argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=")) return undefined;
		if (["--no-pager", "--paginate", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]
			.includes(argument)) {
			index += 1;
			continue;
		}
		if (argument.startsWith("-")) return undefined;
		return cwd.temporary ? { command: argument, args: args.slice(index + 1) } : undefined;
	}
	return undefined;
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

function resolveShellWord(
	node: SyntaxNode,
	context: BashAnalysisContext,
	allowUnquotedExpansion = false,
	allowGlob = false,
): ResolvedShellValue | undefined {
	const temporary = temporaryPathAssignment(node, context);
	if (temporary !== undefined) {
		const quoted = node.text.startsWith("\"") && node.text.endsWith("\"");
		return allowUnquotedExpansion || quoted ? temporary : undefined;
	}
	return resolveShellToken(node.text, context, allowUnquotedExpansion, allowGlob);
}

function resolveShellToken(
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

function shellInvocation(facts: CommandFacts): NestedShell | undefined {
	if (facts.program === undefined || !SHELL_PROGRAMS.has(facts.program)) return undefined;
	const index = shellCommandIndex(facts.args);
	const script = index === undefined ? undefined : facts.args[index + 1];
	if (index === undefined || script === undefined) return undefined;
	const positional = new Map<string, ResolvedShellValue>();
	setPositionalVariables(positional, facts.args.slice(index + 3));
	return { script, positional };
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
