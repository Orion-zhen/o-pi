import { getTreeSitterLanguage } from "../../../syntax-tree/grammars.js";
import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../../../syntax-tree/parser.js";
import type { SyntaxNode } from "../../../syntax-tree/types.js";
import type { ApprovalUnit } from "../../types.js";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "../path.js";
import {
	commandFacts,
	commandUnit,
	redirectUnit,
	resolveShellWord,
	successfulCdTarget,
	temporaryPathAssignment,
	type CommandFacts,
} from "./command.js";
import {
	UNKNOWN_DIRECTORY_PATH,
	allDefined,
	assignContext,
	cloneContext,
	joinContexts,
	joinValues,
	setPositionalVariables,
	type BashAnalysisContext,
	type ResolvedShellValue,
} from "./state.js";
import { walkNamedNodes, walkNamedNodesSkippingFunctions } from "./syntax.js";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
const BASH_GRAMMAR = getTreeSitterLanguage("bash").grammar;

interface ShellFunction {
	body: SyntaxNode;
}

interface BashAnalysisState {
	fallbackCwd: string;
	depth: number;
	units: ApprovalUnit[];
	functions: ReadonlyMap<string, readonly ShellFunction[]>;
	activeFunctions: Set<string>;
}

class BashUnitLimitError extends Error {}

export async function analyzeBashScript(
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
		return true;
	} catch (error) {
		if (error instanceof BashUnitLimitError || error instanceof SyntaxAnalysisTimeoutError) return false;
		throw error;
	} finally {
		document.dispose();
	}
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
			if (!await analyzeBashScript(
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
	let finalBranch = branchBase;
	if (alternative !== undefined) {
		finalBranch = cloneContext(branchBase);
		for (const child of alternative.namedChildren) await analyzeNode(child, finalBranch, state, check);
	}
	assignContext(context, joinContexts([finalBranch, ...branches]));
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
	if (subject !== undefined) await analyzeEmbeddedShell(subject, context, state, check);
	const branches: BashAnalysisContext[] = [];
	let exhaustiveBranch: BashAnalysisContext | undefined;
	for (const item of node.namedChildren.filter((child) => child.type === "case_item")) {
		const branch = cloneContext(context);
		for (const child of item.namedChildren) {
			if (child.type === "word" || child.type === "extglob_pattern") {
				if (child.text === "*") exhaustiveBranch = branch;
				continue;
			}
			await analyzeNode(child, branch, state, check);
		}
		branches.push(branch);
	}
	const first = exhaustiveBranch ?? cloneContext(context);
	const remaining = exhaustiveBranch === undefined ? branches : branches.filter((branch) => branch !== exhaustiveBranch);
	assignContext(context, joinContexts([first, ...remaining]));
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
	if (values.length === 0 || !allDefined(values)) {
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
	const possible: [BashAnalysisContext, ...BashAnalysisContext[]] = [cloneContext(context), ...outcomes];
	context.cwd = joinValues([possible[0].cwd, ...possible.slice(1).map((outcome) => outcome.cwd)])
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
	for (const [index, child] of children.entries()) {
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
	for (const child of parent.children.slice(start + 1, end)) {
		const text = child.text;
		if (text === "&&" || text === "||" || text === ";" || text === "&") return text;
	}
	return undefined;
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
	if (variableOption < 0) return;
	const name = facts.args[variableOption + 1];
	if (name !== undefined) context.variables.delete(name);
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
		if (!await analyzeBashScript(action, state.fallbackCwd, state.depth + 1, state.units, trapContext, state.functions)) {
			throw new BashUnitLimitError();
		}
	}
}

function pushUnit(units: ApprovalUnit[], unit: ApprovalUnit): void {
	if (units.length >= MAX_BASH_UNITS) throw new BashUnitLimitError();
	units.push(unit);
}
