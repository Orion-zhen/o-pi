import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { seedStartupVariables, type StartupFacts } from "./startup.ts";
import { selectedCaseBody, simpleExpansionSites } from "./simple-expansion.ts";
import { TREE_SITTER_LANGUAGES } from "../../../syntax-tree/grammars.ts";
import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../../../syntax-tree/parser.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ApprovalUnit } from "../../types.ts";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "../path.ts";
import {
	commandFacts,
	commandUnit,
	dynamicCommandUnit,
	redirectUnits,
	resolveShellWord,
	type CommandFacts,
} from "./command.ts";
import {
	MAX_BRANCH_CHOICES,
	UNKNOWN_DIRECTORY,
	type Directories,
	UNSET,
	allDefined,
	assignContext,
	cloneContext,
	joinContexts,
	joinDirectories,
	setPositionalVariables,
	type BashAnalysisContext,
	type ResolvedShellValue,
} from "./state.ts";
import { NUMERIC_FIELD, requiredField, walkNamedNodes, walkNamedNodesSkippingFunctions } from "./syntax.ts";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
const BASH_GRAMMAR = TREE_SITTER_LANGUAGES.bash.grammar;

interface ShellFunction {
	body: SyntaxNode;
}

interface BashAnalysisState {
	readonly attributedDeclarations: boolean;
	depth: number;
	units: ApprovalUnit[];
	functions: ReadonlyMap<string, readonly ShellFunction[]>;
	activeFunctions: Set<string>;
}

class IncompleteBashAnalysis extends Error {}

const BASH_NUMBERS = ["RANDOM", "BASHPID", "PPID", "UID", "EUID"];
function initialVariables(bash: boolean): Map<string, ResolvedShellValue> {
	return new Map(bash ? BASH_NUMBERS.map((name) => [name, { value: NUMERIC_FIELD, temporary: false }]) : []);
}

export async function analyzeBashScript(
	script: string,
	cwd: string,
	units: ApprovalUnit[],
	startup?: StartupFacts,
): Promise<boolean> {
	const value = normalizeTargetPath(".", cwd);
	const bash = /(?:^|[/\\])bash(?:\.exe)?$/iu.test(getShellConfig().shell);
	// Windows Bash 可能转换环境路径。SSH 启动的非交互 Bash 也可能读取 bashrc。
	const canNarrow = bash && process.platform !== "win32" && startup?.env.SSH_CLIENT === undefined && startup?.env.SSH2_CLIENT === undefined;
	try {
		await analyzeScript(script, {
			functionNames: new Set(), cwd: [{ value, temporary: isSystemTemporaryDescendant(value) }],
			variables: initialVariables(bash), exitTraps: new Set(),
			...(startup && { usedEnvironment: startup.used }),
		}, 0, units, undefined, startup && { ...startup, canNarrow });
		return true;
	} catch (error) {
		if (error instanceof IncompleteBashAnalysis || error instanceof SyntaxAnalysisTimeoutError) return false;
		throw error;
	}
}

async function analyzeScript(
	script: string, entry: BashAnalysisContext, depth: number, units: ApprovalUnit[],
	inheritedFunctions?: ReadonlyMap<string, readonly ShellFunction[]>, startup?: StartupFacts & { canNarrow: boolean },
): Promise<void> {
	if (script.includes("\0") || depth > MAX_NESTED_SHELL_DEPTH) throw new IncompleteBashAnalysis();
	const document = await parseSyntaxTree(BASH_GRAMMAR, script);
	if (document === undefined) throw new IncompleteBashAnalysis();
	try {
		if (document.root.hasError) throw new IncompleteBashAnalysis();
		const state: BashAnalysisState = {
			attributedDeclarations: document.root.descendantsOfType("declaration_command").length > 0,
			depth,
			units,
			functions: mergeFunctions(inheritedFunctions, collectFunctions(document.root, document.control.check)),
			activeFunctions: new Set(),
		};
		const context = {
			...entry,
			functionNames: new Set([...entry.functionNames, ...state.functions.keys()]),
			simpleSites: startup?.canNarrow ? simpleExpansionSites(document.root.namedChildren, document.control.check) : undefined,
		};
		if (startup) seedStartupVariables(document.root, document.control.check, context.variables, startup.env);
		await analyzeNode(document.root, context, state, document.control.check);
		await analyzeExitTraps(context, state, document.control.check);
	} finally {
		document.dispose();
	}
}

async function analyzeNode(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<Directories | undefined> {
	check();
	if (node.nextSibling?.type === "&") context = cloneContext(context);
	if (node.type === "command" || node.type === "variable_assignment" || node.type === "file_redirect") {
		return analyzeSimpleUnits(node, context, state, check);
	}
	if (node.type === "unset_command") {
		if (context.functionNames.has("unset")) {
			await analyzeFunctionCall({ program: "unset", args: node.namedChildren.map(() => undefined) }, context, state, check);
		}
		updateUnset(node, context, !state.attributedDeclarations);
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
	if (node.type === "while_statement") {
		await analyzeUncertainLoop(node, node.namedChildren, context, state, check);
		return;
	}
	if (node.type === "list" || node.type === "redirected_statement") {
		const [success, failure] = await analyzeOutcomes(node, context, state, check, context.simpleSites?.has(node.id) === true);
		assignContext(context, failure ? joinContexts([success, failure]) : success);
		return;
	}
	if (node.type === "pipeline") {
		let stage = context;
		for (const child of node.namedChildren) {
			stage = cloneContext(context);
			await analyzeNode(child, stage, state, check);
		}
		// lastpipe 可能让最后一段修改当前 Shell。
		assignContext(context, joinContexts([context, stage]));
		return;
	}
	if (node.type === "subshell" || isSubstitution(node)) {
		const nestedContext = cloneContext(context);
		nestedContext.exitTraps.clear();
		for (const child of node.namedChildren) await analyzeNode(child, nestedContext, state, check);
		await analyzeExitTraps(nestedContext, state, check);
		return;
	}
	for (const child of node.namedChildren) await analyzeNode(child, context, state, check);
}

async function analyzeSimpleUnits(
	node: SyntaxNode, context: BashAnalysisContext, state: BashAnalysisState, check: () => void,
): Promise<Directories | undefined> {
	const variants = branchContexts(node, context, check);
	const contexts = variants ?? [context];
	let targets: Directories | undefined;
	if (node.type === "command") {
		const assignments = node.namedChildren.filter((child) => child.type === "variable_assignment");
		const calls = contexts.map((variant) => {
			const invocation = assignments.length ? cloneContext(variant) : variant;
			for (const assignment of assignments) recordAssignment(assignment, invocation);
			return { variant, invocation, command: commandUnit(node, variant, invocation) };
		});
		if (variants && (inPipeline(node) || calls.some(({ command }) => !command.concreteExecution))) {
			const unit = dynamicCommandUnit(node, context);
			if (unit) pushUnit(state, unit);
		}
		const destinations = [];
		for (const { variant, invocation, command } of calls) {
			check();
			destinations.push(await analyzeCommand(node, variant, invocation, command, state, check));
		}
		if (allDefined(destinations)) targets = joinDirectories(destinations.flat());
	} else {
		for (const variant of contexts) {
			if (node.type === "file_redirect") {
				for (const unit of redirectUnits(node, variant)) pushUnit(state, unit, node.text);
			}
			await analyzeEmbeddedShell(node, variant, state, check);
			if (node.type === "variable_assignment") recordAssignment(node, variant);
		}
	}
	if (variants) assignContext(context, joinContexts(variants));
	return targets;
}

async function analyzeCommand(
	node: SyntaxNode, context: BashAnalysisContext, invocation: BashAnalysisContext,
	command: ReturnType<typeof commandUnit>, state: BashAnalysisState, check: () => void,
): Promise<Directories | undefined> {
	if (context.usedEnvironment && !command.dynamicExecution && inPipeline(node)) {
		// 解析出单个程序名并不足以按展开后的整条管道匹配 raw-input。
		const unit = dynamicCommandUnit(node, { ...context, variables: new Map() });
		if (unit) pushUnit(state, unit);
	}
	pushUnit(state, command.unit);
	if (command.nestedShell !== undefined) {
		const nestedContext: BashAnalysisContext = {
			functionNames: context.functionNames,
			cwd: context.cwd,
			variables: new Map([...initialVariables(command.nestedShell.bash), ...command.nestedShell.positional]),
			exitTraps: new Set(),
		};
		await analyzeScript(command.nestedShell.script, nestedContext, state.depth + 1, state.units);
	}
	await analyzeEmbeddedShell(node, context, state, check);
	handleExitTrap(command.rawFacts, context);
	await analyzeFunctionCall(command.rawFacts, invocation, state, check);
	if (invocation !== context && context.functionNames.has(command.rawFacts.program ?? "")) {
		// 函数内的前缀赋值有局部作用域，不能作为调用后的确定值。
		assignContext(context, joinContexts([context, invocation]));
	}
	invalidateCommandState(command.rawFacts, context);
	if (command.positionalArgs && !context.functionNames.has("set")) {
		setPositionalVariables(context.variables, command.positionalArgs);
	}
	if (command.cdTarget !== undefined) {
		context.cwd = joinDirectories([...context.cwd, ...command.cdTarget]);
		// 函数定义可能只在某条分支生效，不能按内建 cd 的退出状态收窄。
		if (command.rawFacts.program !== undefined && context.functionNames.has(command.rawFacts.program)) return;
	}
	return command.cdTarget;
}

// 只展开本单元实际引用的变量。组合超过预算时不截断候选集。
function branchContexts(node: SyntaxNode, context: BashAnalysisContext, check: () => void): [BashAnalysisContext, ...BashAnalysisContext[]] | undefined {
	if (context.variables.size === 0 && context.cwd.length === 1) return;
	let variants = [context];
	const seen = new Set<string>();
	const stack = [node];
	for (let child = stack.pop(); child !== undefined; child = stack.pop()) {
		check();
		if (isSubstitution(child)) continue;
		stack.push(...child.namedChildren);
		if (child.type !== "variable_name" || child.parent?.type === "variable_assignment" || seen.has(child.text)) continue;
		if (child.text === "PWD" && context.cwd.length > 1) {
			if (variants.length * context.cwd.length > MAX_BRANCH_CHOICES) throw new IncompleteBashAnalysis();
			seen.add("PWD");
			variants = variants.flatMap((variant) => context.cwd.map((cwd) => ({ ...cloneContext(variant), cwd: [cwd] })));
			continue;
		}
		const variable = context.variables.get(child.text);
		if (variable === undefined || variable === UNSET || !("choices" in variable)) continue;
		seen.add(child.text);
		if (variants.length * variable.choices.length > MAX_BRANCH_CHOICES) throw new IncompleteBashAnalysis();
		const name = child.text;
		variants = variants.flatMap((variant) => variable.choices.map((value) => {
			const next = cloneContext(variant);
			next.variables.set(name, value);
			return next;
		}));
	}
	const [first, ...rest] = variants;
	return seen.size && first ? [first, ...rest] : undefined;
}

async function analyzeIfStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const remaining = cloneContext(context);
	const branches: BashAnalysisContext[] = [];
	for (const clause of [node, ...node.namedChildren.filter((child) => child.type === "elif_clause")]) {
		let branch = remaining;
		for (const child of clause.children) {
			if (child.type === "then") branch = cloneContext(remaining);
			else if (child.type === "elif_clause" || child.type === "else_clause") break;
			else if (child.isNamed) await analyzeNode(child, branch, state, check);
		}
		branches.push(branch);
	}
	const alternative = node.namedChildren.find((child) => child.type === "else_clause");
	if (alternative !== undefined) await analyzeNode(alternative, remaining, state, check);
	assignContext(context, joinContexts([remaining, ...branches]));
}

async function analyzeCaseStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const subject = requiredField(node, "value");
	const selected = selectedCaseBody(node, subject, context, check);
	if (selected !== undefined) {
		const branch = { ...context, simpleSites: simpleExpansionSites(selected, check) };
		for (const child of selected) await analyzeNode(child, branch, state, check);
		assignContext(context, branch);
		return;
	}
	await analyzeEmbeddedShell(subject, context, state, check);
	const branches: BashAnalysisContext[] = [];
	let exhaustiveBranch: BashAnalysisContext | undefined;
	let fallthrough: BashAnalysisContext | undefined;
	for (const item of node.namedChildren.filter((child) => child.type === "case_item")) {
		const branch = fallthrough === undefined ? cloneContext(context) : joinContexts([context, fallthrough]);
		for (const child of item.namedChildren) {
			if (child.type === "word" || child.type === "extglob_pattern") {
				if (child.text === "*") exhaustiveBranch = branch;
				continue;
			}
			await analyzeNode(child, branch, state, check);
		}
		branches.push(branch);
		if (item.children.some((child) => child.type === ";&" || child.type === ";;&")) {
			fallthrough = fallthrough === undefined ? branch : joinContexts([fallthrough, branch]);
		}
	}
	const first = exhaustiveBranch ?? cloneContext(context);
	const remaining = exhaustiveBranch === undefined ? branches : branches.filter((branch) => branch !== exhaustiveBranch);
	assignContext(context, joinContexts([first, ...remaining]));
}

async function analyzeUncertainLoop(
	node: SyntaxNode,
	children: readonly SyntaxNode[],
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	// 轮数未知时，从新增的可达目录继续分析，直到目录集稳定或退化为未知。
	let pending = context.cwd;
	for (;;) {
		const entry = context.cwd;
		const iteration = cloneContext(context);
		iteration.cwd = pending;
		invalidateAssignedVariables(node, iteration, check);
		for (const child of children) await analyzeNode(child, iteration, state, check);
		mergeUncertainEffects(context, [iteration]);
		if (pending.includes(UNKNOWN_DIRECTORY)) break;
		pending = context.cwd.filter((cwd) => !entry.some((prior) => prior.value === cwd.value));
		if (pending.length === 0) break;
	}
	invalidateAssignedVariables(node, context, check);
}

async function analyzeForStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	const variable = requiredField(node, "variable").text;
	const body = requiredField(node, "body");
	const words = node.childrenForFieldName("value");
	for (const word of words) await analyzeEmbeddedShell(word, context, state, check);
	const values = words.map((word) => resolveShellWord(word, context));
	if (values.length === 0 || !allDefined(values)) {
		return analyzeUncertainLoop(node, [body], context, state, check);
	}
	const iterations: BashAnalysisContext[] = [];
	for (const value of values) {
		const prior = iterations.at(-1);
		const iterationContext = prior === undefined ? cloneContext(context) : joinContexts([context, prior]);
		iterationContext.variables.set(variable, value);
		await analyzeNode(body, iterationContext, state, check);
		iterations.push(iterationContext);
	}
	mergeUncertainEffects(context, iterations);
	context.variables.delete(variable);
	invalidateAssignedVariables(body, context, check);
}

function mergeUncertainEffects(context: BashAnalysisContext, outcomes: readonly BashAnalysisContext[]): void {
	context.cwd = joinDirectories([...context.cwd, ...outcomes.flatMap((outcome) => outcome.cwd)]);
	context.exitTraps = new Set([...context.exitTraps, ...outcomes.flatMap((outcome) => [...outcome.exitTraps])]);
}

async function analyzeOutcomes(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
	knownEntry: boolean,
	redirects: readonly SyntaxNode[] = [],
): Promise<[success: BashAnalysisContext, failure: BashAnalysisContext | undefined]> {
	check();
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const pending = [...node.childrenForFieldName("redirect"), ...redirects];
		if (body !== null) return analyzeOutcomes(body, context, state, check, knownEntry, pending);
		for (const redirect of pending) await analyzeNode(redirect, context, state, check);
		return [context, context];
	}
	if (node.type === "list") {
		const [left, right] = node.namedChildren.filter((child) => child.type !== "comment");
		const and = node.children.some((child) => child.type === "&&");
		if (left === undefined || right === undefined) throw new Error("Missing Bash list operand");
		const [ok, fail] = await analyzeOutcomes(left, context, state, check, knownEntry);
		if (and) {
			const [rightOk, rightFail] = await analyzeOutcomes(right, ok, state, check, false, redirects);
			const failure = fail && rightFail ? joinContexts([fail, rightFail]) : fail ?? rightFail;
			return [rightOk, failure];
		}
		if (!fail) return [ok, undefined];
		const [rightOk, rightFail] = await analyzeOutcomes(right, fail, state, check, false, redirects);
		if (knownEntry && left.type === "command" && left.childForFieldName("name")?.text === "cd" && !context.functionNames.has("cd")
			&& redirects.length === 0 && right.type === "command" && /^exit(?:[ \t]+[0-9]+)?$/u.test(right.text)
			&& !context.functionNames.has("exit") && fail.exitTraps.size === 0) return [ok, undefined];
		return [joinContexts([ok, rightOk]), rightFail];
	}
	const success = cloneContext(context);
	const cdTarget = await analyzeNode(node, success, state, check);
	// 重定向在命令生效前展开。失败时命令可能没有执行。
	for (const redirect of redirects) await analyzeNode(redirect, cloneContext(context), state, check);
	const failure = joinContexts([context, success]);
	if (cdTarget !== undefined) {
		success.cwd = cdTarget;
		failure.cwd = context.cwd;
	}
	return [success, failure];
}

// 单个候选不能代表整条管道的 raw-input，不能据此排除跨命令规则。
function inPipeline(node: SyntaxNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) if (parent.type === "pipeline") return true;
	return false;
}

function isSubstitution(node: SyntaxNode): boolean {
	return node.type === "command_substitution" || node.type === "process_substitution";
}

async function analyzeEmbeddedShell(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<void> {
	if (isSubstitution(node)) {
		await analyzeNode(node, context, state, check);
		return;
	}
	for (const child of node.namedChildren) await analyzeEmbeddedShell(child, context, state, check);
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
		const name = requiredField(node, "name").text;
		const definitions = functions.get(name) ?? [];
		definitions.push({ body: requiredField(node, "body") });
		functions.set(name, definitions);
	}
	return functions;
}

function recordAssignment(node: SyntaxNode, context: BashAnalysisContext): void {
	const name = node.childForFieldName("name")?.text;
	if (name !== undefined && BASH_NUMBERS.includes(name)) {
		context.variables.delete(name);
		return;
	}
	if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !node.text.startsWith(`${name}=`)) {
		if (name !== undefined) context.variables.delete(name);
		return;
	}
	const valueNode = node.childForFieldName("value");
	if (valueNode === null) {
		context.variables.set(name, { value: "", temporary: false });
		return;
	}
	const value = resolveShellWord(valueNode, context, true, true);
	if (value === undefined) context.variables.delete(name);
	else context.variables.set(name, value);
}

function updateUnset(node: SyntaxNode, context: BashAnalysisContext, executed: boolean): void {
	const args = node.namedChildren;
	if (args[0]?.text === "-f") return;
	const names = args[0]?.text === "-v" ? args.slice(1) : args;
	if (names.some((arg) => arg.type !== "variable_name")) {
		context.variables.clear();
		return;
	}
	for (const arg of names) {
		if (executed && !context.functionNames.has("unset") && (/^[a-z_][a-z0-9_]*$/u.test(arg.text) || arg.text === "CDPATH")) context.variables.set(arg.text, UNSET);
		else context.variables.delete(arg.text);
	}
}

function invalidateCommandState(facts: CommandFacts, context: BashAnalysisContext): void {
	const program = facts.program;
	if (program === "builtin" || program === "command") {
		const [name, ...args] = facts.args;
		if (name !== undefined && name !== "builtin" && name !== "command") invalidateCommandState({ program: name, args }, context);
		return;
	}
	// eval 和 source 在当前 Shell 中执行未知代码，先前的变量值不再可靠。
	if (program === "eval" || program === "source" || program === ".") {
		context.variables.clear();
		context.cwd = [UNKNOWN_DIRECTORY];
		return;
	}
	if (program === "pushd" || program === "popd") {
		context.cwd = [UNKNOWN_DIRECTORY];
		return;
	}
	if (program === "shift" || program === "set" && facts.args.length > 0) {
		setPositionalVariables(context.variables, []);
		return;
	}
	if (program === "read" || program === "readarray" || program === "mapfile" || program === "unset") {
		if (!allDefined(facts.args)) {
			context.variables.clear();
			return;
		}
		for (const argument of facts.args) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(argument)) context.variables.delete(argument);
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

function invalidateAssignedVariables(node: SyntaxNode, context: BashAnalysisContext, check: () => void, functionScope = false): void {
	for (const candidate of walkNamedNodesSkippingFunctions(node, check)) {
		if (candidate.type === "variable_assignment") {
			const name = candidate.childForFieldName("name")?.text;
			if (name !== undefined) context.variables.delete(name);
			continue;
		}
		if (candidate.type === "for_statement") {
			context.variables.delete(requiredField(candidate, "variable").text);
			continue;
		}
		if (candidate.type === "unset_command") updateUnset(candidate, context, false);
		if (candidate.type === "command") {
			const facts = commandFacts(candidate, context);
			if (functionScope && (facts.program === "set" || facts.program === "shift")) continue;
			invalidateCommandState(facts, context);
		}
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
		const directories = [...context.cwd];
		for (const definition of definitions) {
			const functionContext = cloneContext(context);
			setPositionalVariables(functionContext.variables, facts.args);
			await analyzeNode(definition.body, functionContext, state, check);
			invalidateAssignedVariables(definition.body, context, check, true);
			trapOutcomes.push(functionContext.exitTraps);
			directories.push(...functionContext.cwd);
		}
		context.cwd = joinDirectories(directories);
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
		await analyzeScript(action, trapContext, state.depth + 1, state.units, state.functions);
	}
}

function pushUnit(state: BashAnalysisState, unit: ApprovalUnit, source = unit.target.value): void {
	if (state.units.length >= MAX_BASH_UNITS) throw new IncompleteBashAnalysis();
	if (state.depth === 0) unit.source = source;
	state.units.push(unit);
}
