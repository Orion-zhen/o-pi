import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { seedStartupVariables, type StartupFacts } from "./startup.ts";
import { selectedCaseBody, simpleExpansionSites } from "./simple-expansion.ts";
import { TREE_SITTER_LANGUAGES } from "../../../syntax-tree/grammars.ts";
import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../../../syntax-tree/parser.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ApprovalUnit, BashArgv, BashPipeline } from "../../types.ts";
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
	IncompleteBashAnalysis,
	cloneContext,
	joinPaths,
	joinDirectories,
	setPositionalVariables,
	type BashAnalysisContext,
	type ResolvedShellValue,
} from "./state.ts";
import { NUMERIC_FIELD, requiredField, staticSudoCommand, walkNamedNodes, walkNamedNodesSkippingFunctions } from "./syntax.ts";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
const BASH_GRAMMAR = TREE_SITTER_LANGUAGES.bash.grammar;

interface ShellFunction {
	body: SyntaxNode;
}

interface BashAnalysisState {
	readonly attributedDeclarations: boolean;
	signal: AbortSignal | undefined;
	depth: number;
	units: ApprovalUnit[];
	pipelines: BashPipeline[];
	stage?: { node: number; commands: BashArgv[] };
	functions: ReadonlyMap<string, readonly ShellFunction[]>;
	activeFunctions: Set<string>;
}

type Paths = BashAnalysisContext[];

const BASH_NUMBERS = ["RANDOM", "BASHPID", "PPID", "UID", "EUID"];
function initialVariables(bash: boolean): Map<string, ResolvedShellValue> {
	return new Map(bash ? BASH_NUMBERS.map((name) => [name, { value: NUMERIC_FIELD, temporary: false }]) : []);
}

export async function analyzeBashScript(
	script: string,
	cwd: string,
	output: Pick<BashAnalysisState, "units" | "pipelines" | "signal">,
	startup: StartupFacts | undefined,
	inspectSudo: boolean,
): Promise<{ askpassCommand: string | undefined } | undefined> {
	const value = normalizeTargetPath(".", cwd);
	const bash = /(?:^|[/\\])bash(?:\.exe)?$/iu.test(getShellConfig().shell);
	// Windows Bash 可能转换环境路径。SSH 启动的非交互 Bash 也可能读取 bashrc。
	const canNarrow = bash && process.platform !== "win32" && startup?.env.SSH_CLIENT === undefined && startup?.env.SSH2_CLIENT === undefined;
	try {
		const askpassCommand = await analyzeScript(script, {
			functionNames: new Set(), cwd: [{ value, temporary: isSystemTemporaryDescendant(value) }],
			variables: initialVariables(bash), exitTrap: undefined,
			...(startup && { usedEnvironment: startup.used }),
		}, 0, output, undefined, startup && { ...startup, canNarrow, inspectSudo });
		return { askpassCommand };
	} catch (error) {
		if (error instanceof IncompleteBashAnalysis || error instanceof SyntaxAnalysisTimeoutError) return;
		throw error;
	}
}

async function analyzeScript(
	script: string, entry: BashAnalysisContext, depth: number, output: Pick<BashAnalysisState, "units" | "pipelines" | "signal">,
	inheritedFunctions?: ReadonlyMap<string, readonly ShellFunction[]>, startup?: StartupFacts & { canNarrow: boolean; inspectSudo: boolean },
): Promise<string | undefined> {
	if (script.includes("\0") || depth > MAX_NESTED_SHELL_DEPTH) throw new IncompleteBashAnalysis();
	const document = await parseSyntaxTree(BASH_GRAMMAR, script, output.signal);
	if (document === undefined) throw new IncompleteBashAnalysis();
	try {
		if (document.root.hasError) throw new IncompleteBashAnalysis();
		const state: BashAnalysisState = {
			attributedDeclarations: document.root.descendantsOfType("declaration_command").length > 0,
			depth,
			units: output.units, pipelines: output.pipelines, signal: output.signal,
			functions: mergeFunctions(inheritedFunctions, collectFunctions(document.root, document.control.check)),
			activeFunctions: new Set(),
		};
		const context = {
			...entry,
			functionNames: new Set([...entry.functionNames, ...state.functions.keys()]),
			simpleSites: startup?.canNarrow ? simpleExpansionSites(document.root.namedChildren, document.control.check) : undefined,
		};
		if (startup) seedStartupVariables(document.root, document.control.check, context.variables, startup.env);
		const paths = await analyzeNode(document.root, [context], state, document.control.check);
		await analyzeExitTraps(paths, state, document.control.check);
		if (startup?.inspectSudo) return staticSudoCommand(script, document.root);
	} finally {
		document.dispose();
	}
}

async function analyzeNodes(nodes: readonly SyntaxNode[], paths: Paths, state: BashAnalysisState, check: () => void): Promise<Paths> {
	for (const node of nodes) paths = await analyzeNode(node, paths, state, check);
	return paths;
}

async function analyzeNode(node: SyntaxNode, paths: Paths, state: BashAnalysisState, check: () => void): Promise<Paths> {
	const outcomes: Paths = [];
	for (const path of paths) {
		check();
		outcomes.push(...await analyzeOne(node, path, state, check));
	}
	return node.nextSibling?.type === "&" ? paths : joinPaths(outcomes);
}

async function analyzeOne(node: SyntaxNode, context: BashAnalysisContext, state: BashAnalysisState, check: () => void): Promise<Paths> {
	if (node.type === "command" || node.type === "variable_assignment" || node.type === "file_redirect") {
		return (await analyzeSimpleUnits(node, cloneContext(context), state, check)).paths;
	}
	if (node.type === "unset_command") {
		const paths = await analyzeFunctionCall({ program: "unset", args: node.namedChildren.map((child) => ({ source: child.text })) }, cloneContext(context), state, check);
		for (const path of paths) {
			updateUnset(node, path, !state.attributedDeclarations);
			await analyzeEmbeddedShell(node, path, state, check);
		}
		return paths;
	}
	if (node.type === "function_definition") return [context];
	if (node.type === "if_statement") return analyzeIfStatement(node, context, state, check);
	if (node.type === "case_statement") return analyzeCaseStatement(node, context, state, check);
	if (node.type === "for_statement") return analyzeForStatement(node, context, state, check);
	if (node.type === "while_statement") return analyzeUncertainLoop(node, node.namedChildren, context, state, check);
	if (node.type === "list" || node.type === "redirected_statement") {
		const [success, failure] = await analyzeOutcomes(node, [context], state, check, context.simpleSites?.has(node.id) === true);
		return joinPaths([...success, ...failure]);
	}
	if (node.type === "pipeline") {
		const stages: BashArgv[][] = [];
		state.pipelines.push({ stages, unit: { action: "execute", target: { kind: "command", value: node.text }, remember: false } });
		let stage = [context];
		for (const child of node.namedChildren) {
			if (child.type === "comment") continue;
			const commands: BashArgv[] = [];
			stages.push(commands);
			stage = await analyzeNode(child, [context], { ...state, stage: { node: child.id, commands } }, check);
		}
		if (node.nextSibling?.type === "&" && stages.filter((variants) => variants.some(([program]) => state.activeFunctions.has(program))).length >= 2) {
			pushUnit(state, { action: "execute", target: { kind: "command", value: node.text }, analysisFact: "system.disrupt-host", remember: false });
		}
		// lastpipe 可能让最后一段修改当前 Shell。
		return joinPaths([context, ...stage]);
	}
	if (node.type === "subshell" || isSubstitution(node)) {
		const nested = await analyzeNodes(node.namedChildren, [{ ...context, exitTrap: undefined }], state, check);
		await analyzeExitTraps(nested, state, check);
		return [context];
	}
	return analyzeNodes(node.namedChildren, [context], state, check);
}

async function analyzeSimpleUnits(
	node: SyntaxNode, context: BashAnalysisContext, state: BashAnalysisState, check: () => void,
): Promise<{ paths: Paths; cdTarget?: Directories }> {
	const variants = branchContexts(node, context, check);
	const contexts = variants ?? [context];
	if (node.type === "command") {
		const assignments = node.namedChildren.filter((child) => child.type === "variable_assignment");
		const calls = contexts.map((variant) => {
			const invocation = assignments.length ? cloneContext(variant) : variant;
			for (const assignment of assignments) recordAssignment(assignment, invocation);
			return { variant, invocation, command: commandUnit(node, variant, invocation) };
		});
		const seenOpaque = new Set<string>();
		function append(unit: ApprovalUnit | undefined): void {
			if (!unit) return;
			if (variants && unit.analysisFact) {
				const key = JSON.stringify([unit.commands, unit.remember, unit.effect_scope]);
				if (seenOpaque.has(key)) return;
				seenOpaque.add(key);
			}
			pushUnit(state, unit);
		}
		const pipeline = inPipeline(node);
		if (variants && (pipeline || calls.some(({ command }) => !command.concreteExecution))) append(dynamicCommandUnit(node, context));
		const checkedDirectories = new Set<Directories>();
		const destinations = [];
		const paths: Paths = [];
		for (const { variant, invocation, command } of calls) {
			check();
			// 清空变量后，候选上下文之间只有工作目录会影响命令展开。
			if (pipeline && context.usedEnvironment && command.checkWithoutVariables && !checkedDirectories.has(variant.cwd)) {
				checkedDirectories.add(variant.cwd);
				append(dynamicCommandUnit(node, { ...variant, variables: new Map() }));
			}
			append(command.unit);
			paths.push(...await analyzeCommand(node, variant, invocation, command, state, check));
			// 同名函数可能取代内建 cd，不能按内建命令的退出状态收窄。
			destinations.push(variant.functionNames.has(command.rawFacts.program ?? "") ? undefined : command.cdTarget);
		}
		return { paths: joinPaths(paths), ...(allDefined(destinations) && { cdTarget: joinDirectories(destinations.flat()) }) };
	}
	for (const variant of contexts) {
		if (node.type === "file_redirect") {
			for (const unit of redirectUnits(node, variant)) pushUnit(state, unit, node.text);
		}
		await analyzeEmbeddedShell(node, variant, state, check);
		if (node.type === "variable_assignment") recordAssignment(node, variant);
	}
	return { paths: joinPaths(contexts) };
}

async function analyzeCommand(
	node: SyntaxNode, context: BashAnalysisContext, invocation: BashAnalysisContext,
	command: ReturnType<typeof commandUnit>, state: BashAnalysisState, check: () => void,
): Promise<Paths> {
	if (state.stage && belongsToStage(node, state.stage.node)) state.stage.commands.push(...command.unit.commands);
	if (command.nestedShell !== undefined) {
		const nestedContext: BashAnalysisContext = {
			functionNames: context.functionNames,
			cwd: context.cwd,
			variables: new Map([...initialVariables(command.nestedShell.bash), ...command.nestedShell.positional]),
			exitTrap: undefined,
		};
		await analyzeScript(command.nestedShell.script, nestedContext, state.depth + 1, state);
	}
	await analyzeEmbeddedShell(node, context, state, check);
	handleExitTrap(command.rawFacts, context);
	if (command.rawFacts.program === "exit") await analyzeExitTraps([invocation], state, check);
	const paths = await analyzeFunctionCall(command.rawFacts, context, state, check, invocation);
	for (const path of paths) {
		invalidateCommandState(command.rawFacts, path);
		if (command.positionalArgs && !path.functionNames.has("set")) setPositionalVariables(path.variables, command.positionalArgs);
		if (command.cdTarget !== undefined) path.cwd = joinDirectories([...path.cwd, ...command.cdTarget]);
	}
	return paths;
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
): Promise<Paths> {
	let remaining = [context];
	const branches: Paths = [];
	for (const clause of [node, ...node.namedChildren.filter((child) => child.type === "elif_clause")]) {
		const children = clause.children;
		const then = children.findIndex((child) => child.type === "then");
		const conditions = children.slice(0, then).filter((child) => child.isNamed && child.type !== "comment");
		const last = conditions.pop();
		if (!last) throw new IncompleteBashAnalysis();
		const entry = await analyzeNodes(conditions, remaining, state, check);
		const [ok, fail] = last.nextSibling?.type === "&"
			? [await analyzeNode(last, entry, state, check), entry]
			: await analyzeOutcomes(last, entry, state, check, false);
		remaining = fail;
		const body = children.slice(then + 1).filter((child) => child.isNamed && child.type !== "elif_clause" && child.type !== "else_clause");
		branches.push(...await analyzeNodes(body, ok, state, check));
	}
	const alternative = node.namedChildren.find((child) => child.type === "else_clause");
	if (alternative !== undefined) remaining = await analyzeNode(alternative, remaining, state, check);
	return joinPaths([...remaining, ...branches]);
}

async function analyzeCaseStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<Paths> {
	const subject = requiredField(node, "value");
	const selected = selectedCaseBody(node, subject, context, check);
	if (selected !== undefined) {
		const branch = { ...context, simpleSites: simpleExpansionSites(selected, check) };
		const paths = await analyzeNodes(selected, [branch], state, check);
		return paths.map((path) => ({ ...path, simpleSites: context.simpleSites }));
	}
	await analyzeEmbeddedShell(subject, context, state, check);
	const branches: Paths = [];
	let exhaustive = false;
	let fallthrough: Paths = [];
	for (const item of node.namedChildren.filter((child) => child.type === "case_item")) {
		let branch = joinPaths([context, ...fallthrough]);
		for (const child of item.namedChildren) {
			if (child.type === "word" || child.type === "extglob_pattern") {
				if (child.text === "*") exhaustive = true;
				continue;
			}
			branch = await analyzeNode(child, branch, state, check);
		}
		branches.push(...branch);
		if (item.children.some((child) => child.type === ";&" || child.type === ";;&")) {
			fallthrough = joinPaths([...fallthrough, ...branch]);
		}
	}
	return joinPaths(exhaustive ? branches : [context, ...branches]);
}

async function analyzeUncertainLoop(
	node: SyntaxNode,
	children: readonly SyntaxNode[],
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<Paths> {
	// 轮数未知时，从每个 EXIT 动作新增的可达目录继续分析。
	const initial = cloneContext(context);
	invalidateAssignedVariables(node, initial, check);
	let reached = [initial];
	let pending = reached;
	while (pending.length) {
		const outcomes = await analyzeNodes(children, pending, state, check);
		const widened = outcomes.map(cloneContext);
		for (const path of widened) invalidateAssignedVariables(node, path, check);
		const next = joinPaths([...reached, ...widened]);
		pending = [];
		for (const path of next) {
			const prior = reached.find((item) => item.exitTrap === path.exitTrap);
			if (prior?.cwd.includes(UNKNOWN_DIRECTORY)) continue;
			const cwd = path.cwd.filter((dir) => !prior?.cwd.some((old) => old.value === dir.value));
			if (cwd.length) pending.push({ ...path, cwd });
		}
		reached = next;
	}
	return reached;
}

async function analyzeForStatement(
	node: SyntaxNode,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
): Promise<Paths> {
	const variable = requiredField(node, "variable").text;
	const body = requiredField(node, "body");
	const words = node.childrenForFieldName("value");
	for (const word of words) await analyzeEmbeddedShell(word, context, state, check);
	const values = words.map((word) => resolveShellWord(word, context));
	if (values.length === 0 || !allDefined(values)) {
		return analyzeUncertainLoop(node, [body], context, state, check);
	}
	const iterations: Paths = [context];
	let prior: Paths = [];
	for (const value of values) {
		const entry = joinPaths([cloneContext(context), ...prior]);
		for (const path of entry) path.variables.set(variable, value);
		prior = await analyzeNode(body, entry, state, check);
		iterations.push(...prior);
	}
	const paths = joinPaths(iterations);
	for (const path of paths) {
		path.variables.delete(variable);
		invalidateAssignedVariables(body, path, check);
	}
	return paths;
}

async function analyzeOutcomes(
	node: SyntaxNode,
	entries: Paths,
	state: BashAnalysisState,
	check: () => void,
	knownEntry: boolean,
	redirects: readonly SyntaxNode[] = [],
): Promise<[success: Paths, failure: Paths]> {
	check();
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const pending = [...node.childrenForFieldName("redirect"), ...redirects];
		if (body !== null) return analyzeOutcomes(body, entries, state, check, knownEntry, pending);
		await analyzeNodes(pending, entries, state, check);
		return [entries, entries];
	}
	if (node.type === "list") {
		const [left, right] = node.namedChildren.filter((child) => child.type !== "comment");
		const and = node.children.some((child) => child.type === "&&");
		if (left === undefined || right === undefined) throw new Error("Missing Bash list operand");
		const [ok, fail] = await analyzeOutcomes(left, entries, state, check, knownEntry);
		if (and) {
			const [rightOk, rightFail] = await analyzeOutcomes(right, ok, state, check, false, redirects);
			return [rightOk, joinPaths([...fail, ...rightFail])];
		}
		if (!fail.length) return [ok, []];
		const [rightOk, rightFail] = await analyzeOutcomes(right, fail, state, check, false, redirects);
		if (knownEntry && left.type === "command" && left.childForFieldName("name")?.text === "cd"
			&& redirects.length === 0 && right.type === "command" && /^exit(?:[ \t]+[0-9]+)?$/u.test(right.text)
			&& fail.every((path) => !path.functionNames.has("cd") && !path.functionNames.has("exit") && path.exitTrap === undefined)) return [ok, []];
		return [joinPaths([...ok, ...rightOk]), rightFail];
	}
	const success: Paths = [], failure: Paths = [];
	for (const entry of entries) {
		const { paths, cdTarget } = node.type === "command"
			? await analyzeSimpleUnits(node, cloneContext(entry), state, check)
			: { paths: await analyzeNode(node, [entry], state, check), cdTarget: undefined };
		// 重定向在命令生效前展开。失败时命令可能没有执行。
		await analyzeNodes(redirects, [entry], state, check);
		failure.push(entry);
		for (const path of paths) {
			success.push(cdTarget ? { ...path, cwd: cdTarget } : path);
			failure.push(cdTarget ? { ...path, cwd: entry.cwd } : path);
		}
	}
	return [joinPaths(success), joinPaths(failure)];
}

// 单个候选不能代表整条管道。
function inPipeline(node: SyntaxNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) if (parent.type === "pipeline") return true;
	return false;
}

// 分组内的命令共享该阶段的管道。参数里的替换有独立的输入输出，不归入外层阶段。
function belongsToStage(node: SyntaxNode, stage: number): boolean {
	for (let current: SyntaxNode | null = node; current !== null; current = current.parent) {
		if (current.id === stage) return true;
		if (isSubstitution(current) || current.type === "pipeline") return false;
	}
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
		await analyzeNode(node, [context], state, check);
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
		if (typeof name === "string" && name !== "builtin" && name !== "command") invalidateCommandState({ program: name, args }, context);
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
		if (!facts.args.every((arg) => typeof arg === "string")) {
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
		if (typeof name === "string") context.variables.delete(name);
		return;
	}
	if (program !== "printf") return;
	const variableOption = facts.args.findIndex((argument) => argument === "-v");
	if (variableOption < 0) return;
	const name = facts.args[variableOption + 1];
	if (typeof name === "string") context.variables.delete(name);
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
	invocation = context,
): Promise<Paths> {
	const name = facts.program;
	const definitions = name === undefined ? undefined : state.functions.get(name);
	if (name === undefined || definitions === undefined || state.activeFunctions.has(name)) return [context];
	state.activeFunctions.add(name);
	try {
		const outcomes: Paths = [];
		for (const definition of definitions) {
			const functionContext = cloneContext(invocation);
			setPositionalVariables(functionContext.variables, facts.args);
			const paths = await analyzeNode(definition.body, [functionContext], state, check);
			const caller = cloneContext(context);
			invalidateAssignedVariables(definition.body, caller, check, true);
			for (const path of paths) {
				// 位置参数恢复调用者的绑定。嵌套函数已使其失效的普通变量不能恢复。
				const variables = new Map(caller.variables);
				for (const name of variables.keys()) if (!path.variables.has(name) && !/^[1-9]\d*$/u.test(name)) variables.delete(name);
				outcomes.push({ ...caller, variables, exitTrap: path.exitTrap, cwd: joinDirectories([...caller.cwd, ...path.cwd]) });
			}
		}
		return joinPaths(outcomes);
	} finally {
		state.activeFunctions.delete(name);
	}
}

function handleExitTrap(facts: CommandFacts, context: BashAnalysisContext): void {
	if (facts.program !== "trap" || facts.args.length < 2) return;
	const action = facts.args[0];
	if (typeof action !== "string" || !facts.args.slice(1).some((signal) => signal === "EXIT" || signal === "0")) return;
	context.exitTrap = action === "-" ? undefined : action;
}

async function analyzeExitTraps(paths: Paths, state: BashAnalysisState, check: () => void): Promise<void> {
	for (const context of paths) {
		const action = context.exitTrap;
		if (action === undefined) continue;
		const trapContext = { ...context, exitTrap: undefined };
		if (state.functions.has(action)) {
			await analyzeFunctionCall({ program: action, args: [] }, trapContext, state, check);
			continue;
		}
		await analyzeScript(action, trapContext, state.depth + 1, state, state.functions);
	}
}

function pushUnit(state: BashAnalysisState, unit: ApprovalUnit, source = unit.target.value): void {
	if (state.units.length >= MAX_BASH_UNITS) throw new IncompleteBashAnalysis();
	if (state.depth === 0) unit.source = source;
	state.units.push(unit);
}
