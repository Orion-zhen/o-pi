import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { gitScopeVariable } from "../../rules/command-syntax.ts";
import { isOrdinaryVariable, seedStartupVariables, type StartupFacts } from "./startup.ts";
import { expansionWrite, invalidateAssignedVariables, invalidateCommandState, literalTest, plainDeclaration, recordAssignment, traceableBlock, updateUnset } from "./bindings.ts";
import { selectedCaseBody, simpleExpansionSites } from "./simple-expansion.ts";
import { TREE_SITTER_LANGUAGES } from "../../../syntax-tree/grammars.ts";
import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../../../syntax-tree/parser.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ApprovalUnit, ShellArgv, ShellPipeline } from "../../types.ts";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "../path.ts";
import {
	commandUnit,
	dynamicCommandUnit,
	redirectUnits,
	resolveShellWord,
	type CommandFacts,
} from "./command.ts";
import { UNKNOWN_DIRECTORY, IncompleteBashAnalysis, cloneContext, contextsForReads, joinPaths, joinDirectories,
	type Directories, type BashAnalysisContext, type ResolvedShellValue } from "./branches.ts";
import { allDefined, isPositionalVariable, positionalValues, restorePositionalVariables, setPositionalVariables, shellArgumentValue } from "./state.ts";
import { NUMERIC_FIELD, requiredField, staticSudoCommand, walkNamedNodes, walkCurrentScope } from "./syntax.ts";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
const BASH_GRAMMAR = TREE_SITTER_LANGUAGES.bash.grammar;

type FunctionBodies = ReadonlyMap<string, readonly SyntaxNode[]>;

interface BashAnalysisState {
	readonly attributedDeclarations: boolean;
	signal: AbortSignal | undefined;
	depth: number;
	units: ApprovalUnit[];
	pipelines: ShellPipeline[];
	stage?: { node: number; commands: ShellArgv[] };
	functions: FunctionBodies;
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
	const localStartup = startup !== undefined && startup.env.SSH_CLIENT === undefined && startup.env.SSH2_CLIENT === undefined;
	const canNarrow = localStartup && bash;
	try {
		const askpassCommand = await analyzeScript(script, {
			functionNames: new Set(), definitions: new Map(), plainBindings: canNarrow, bash, cwd: [{ value, temporary: isSystemTemporaryDescendant(value) }],
			variables: initialVariables(bash), exitTrap: undefined,
			gitEnvKnown: localStartup && !Object.keys(startup.env).some(name => gitScopeVariable.test(name)),
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
	inherited?: Pick<BashAnalysisState, "functions" | "attributedDeclarations">, startup?: StartupFacts & { canNarrow: boolean; inspectSudo: boolean },
): Promise<string | undefined> {
	if (script.includes("\0") || depth > MAX_NESTED_SHELL_DEPTH) throw new IncompleteBashAnalysis();
	const document = await parseSyntaxTree(BASH_GRAMMAR, script, output.signal);
	if (document === undefined) throw new IncompleteBashAnalysis();
	try {
		if (document.root.hasError) throw new IncompleteBashAnalysis();
		const state: BashAnalysisState = {
			attributedDeclarations: inherited?.attributedDeclarations === true || document.root.descendantsOfType("declaration_command").length > 0,
			depth,
			units: output.units, pipelines: output.pipelines, signal: output.signal,
			functions: collectFunctions(document.root, document.control.check, inherited?.functions),
			activeFunctions: new Set(),
		};
		const context = {
			...entry,
			functionNames: new Set([...entry.functionNames, ...state.functions.keys()]),
			simpleSites: startup?.canNarrow ? simpleExpansionSites(document.root.namedChildren, document.control.check) : undefined,
		};
		if (startup) seedStartupVariables(document.root, document.control.check, context.variables, startup.env);
		const paths = await analyzeNode(document.root, [context], state, document.control.check);
		await analyzeExitTraps(paths, state);
		if (startup?.inspectSudo) return staticSudoCommand(script, document.root);
	} finally {
		document.dispose();
	}
}

async function analyzeNodes(nodes: readonly SyntaxNode[], paths: Paths, state: BashAnalysisState, check: () => void): Promise<Paths> {
	for (const node of nodes) {
		if (!paths.length) break;
		paths = await analyzeNode(node, paths, state, check);
	}
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
	const modified = expansionWrite(node, context);
	if (modified) { context = cloneContext(context); context.variables.delete(modified); }
	if (context.locals && node.type === "declaration_command" && node.firstChild?.type === "local") {
		const locals = new Map(context.locals);
		for (const child of node.namedChildren) {
			const name = child.childForFieldName("name")?.text;
			if (name && !locals.has(name)) locals.set(name, context.variables.get(name));
		}
		context = { ...context, locals };
	}
	if (node.type === "declaration_command") {
		const plain = plainDeclaration(node);
		const kind = node.firstChild?.type;
		const ordinaryExport = kind === "export" && !context.functionNames.has("export") && node.namedChildren.every(child =>
			isOrdinaryVariable(child.childForFieldName("name")?.text ?? child.text));
		context = { ...context, gitEnvKnown: context.gitEnvKnown && plain,
			plainBindings: context.plainBindings && plain && (kind === "local" || ordinaryExport) };
	}
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
	if (node.type === "function_definition") {
		const definitions = new Map(context.definitions).set(requiredField(node, "name").text, [requiredField(node, "body")]);
		return [{ ...context, definitions }];
	}
	if (node.type === "if_statement") return analyzeIfStatement(node, context, state, check);
	if (node.type === "case_statement") return analyzeCaseStatement(node, context, state, check);
	if (node.type === "for_statement") return analyzeForStatement(node, context, state, check);
	if (node.type === "while_statement" || node.type === "c_style_for_statement") return analyzeUncertainLoop(node, node.namedChildren, context, state, check);
	if (node.type === "list" || node.type === "redirected_statement") {
		const [success, failure] = await analyzeOutcomes(node, [context], state, check);
		return joinPaths([...success, ...failure]);
	}
	if (node.type === "pipeline") {
		const stages: ShellArgv[][] = [];
		state.pipelines.push({ stages, unit: { action: "execute", target: { kind: "command", value: node.text }, remember: false } });
		let stage = [context];
		for (const child of node.namedChildren) {
			if (child.type === "comment") continue;
			const commands: ShellArgv[] = [];
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
		await analyzeExitTraps(nested, state);
		return [context];
	}
	return analyzeNodes(node.namedChildren, [context], state, check);
}

async function analyzeSimpleUnits(
	node: SyntaxNode, context: BashAnalysisContext, state: BashAnalysisState, check: () => void,
): Promise<{ paths: Paths; cdTarget?: Directories }> {
	if (/[=+\-]/u.test(node.text)) for (const child of walkCurrentScope(node, check)) {
		const modified = expansionWrite(child, context);
		if (modified) context.variables.delete(modified);
	}
	const contexts = contextsForReads(context, variableReads(node, check));
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
			if (contexts.length > 1 && unit.analysisFact) {
				const key = JSON.stringify([unit.commands, unit.remember, unit.effect_scope]);
				if (seenOpaque.has(key)) return;
				seenOpaque.add(key);
			}
			pushUnit(state, unit);
		}
		const pipeline = inPipeline(node);
		if (contexts.length > 1 && (pipeline || calls.some(({ command }) => !command.concreteExecution))) append(dynamicCommandUnit(node, context));
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
			destinations.push(variant.functionNames.has(command.invoked.program ?? "") ? undefined : command.cdTarget);
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
			functionNames: context.functionNames, definitions: new Map(), plainBindings: false, bash: command.nestedShell.bash,
			gitEnvKnown: false,
			cwd: context.cwd,
			variables: initialVariables(command.nestedShell.bash),
			exitTrap: undefined,
		};
		setPositionalVariables(nestedContext.variables, command.nestedShell.args);
		await analyzeScript(command.nestedShell.script, nestedContext, state.depth + 1, state);
	}
	await analyzeEmbeddedShell(node, context, state, check);
	handleExitTrap(command.invoked, context);
	if (command.invoked.program === "exit") {
		await analyzeExitTraps([invocation], state);
		if (terminatingExit(node, context)) return [];
	}
	const paths = await analyzeFunctionCall({ ...command.invoked, args: command.fields }, context, state, check, invocation);
	for (const path of paths) {
		const direct = node.childForFieldName("name")?.text === command.invoked.program;
		invalidateCommandState(command.invoked, path, direct ? command.fields : undefined);
		if (command.cdTarget !== undefined) path.cwd = joinDirectories([...path.cwd, ...command.cdTarget]);
	}
	return paths;
}

function* variableReads(node: SyntaxNode, check: () => void): Generator<string> {
	const stack = [node];
	for (let child = stack.pop(); child !== undefined; child = stack.pop()) {
		check();
		if (isSubstitution(child)) continue;
		stack.push(...child.namedChildren);
		if (child.type !== "variable_name") continue;
		if (child.parent?.type === "variable_assignment" && !child.parent.children.some(c => c.type === "+=")) continue;
		yield child.text;
	}
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
			: await analyzeOutcomes(last, entry, state, check);
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
	if (node.descendantsOfType("function_definition").length) initial.plainBindings = false;
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
	const values = !words.length && !node.children.some(n => n.type === "in") ? positionalValues(context)?.map(shellArgumentValue) : words.map(word => resolveShellWord(word, context));
	if (!values || !allDefined(values)) {
		return analyzeUncertainLoop(node, [body], context, state, check);
	}
	if (!values.length) return [context];
	if (traceableBlock(body, context, check) && isOrdinaryVariable(variable)) {
		let paths = [cloneContext(context)];
		for (const value of values) {
			for (const path of paths) path.variables.set(variable, value);
			paths = await analyzeNode(body, paths, state, check);
		}
		return paths;
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
	redirects: readonly SyntaxNode[] = [],
): Promise<[success: Paths, failure: Paths]> {
	if (!entries.length) return [[], []];
	check();
	if (node.type === "redirected_statement") {
		const body = node.childForFieldName("body");
		const pending = [...node.childrenForFieldName("redirect"), ...redirects];
		if (body !== null) return analyzeOutcomes(body, entries, state, check, pending);
		await analyzeNodes(pending, entries, state, check);
		return [entries, entries];
	}
	if (node.type === "list") {
		const [left, right] = node.namedChildren.filter((child) => child.type !== "comment");
		const and = node.children.some((child) => child.type === "&&");
		if (left === undefined || right === undefined) throw new Error("Missing Bash list operand");
		const [ok, fail] = await analyzeOutcomes(left, entries, state, check);
		if (and) {
			const [rightOk, rightFail] = await analyzeOutcomes(right, ok, state, check, redirects);
			return [rightOk, joinPaths([...fail, ...rightFail])];
		}
		const [rightOk, rightFail] = await analyzeOutcomes(right, fail, state, check, redirects);
		return [joinPaths([...ok, ...rightOk]), rightFail];
	}
	const success: Paths = [], failure: Paths = [];
	for (const entry of entries) {
		const { paths, cdTarget } = node.type === "command"
			? await analyzeSimpleUnits(node, cloneContext(entry), state, check)
			: { paths: await analyzeNode(node, [entry], state, check), cdTarget: undefined };
		// 重定向在命令生效前展开。失败时命令可能没有执行。
		await analyzeNodes(redirects, [entry], state, check);
		if (!paths.length && !redirects.length) continue;
		const constant = entry.plainBindings && !redirects.length;
		const test = constant && !entry.functionNames.has(node.text) && /^(?::|true|false)$/u.test(node.text) ? node.text !== "false"
			: constant ? literalTest(node) : undefined;
		if (test !== true) failure.push(entry);
		for (const path of paths) {
			if (test !== false) success.push(cdTarget ? { ...path, cwd: cdTarget } : path);
			if (test !== true) failure.push(cdTarget ? { ...path, cwd: entry.cwd } : path);
		}
	}
	return [joinPaths(success), joinPaths(failure)];
}

function terminatingExit(node: SyntaxNode, context: BashAnalysisContext): boolean {
	return node.type === "command" && context.plainBindings && !context.functionNames.has("exit") && context.exitTrap === undefined && /^exit(?:[ \t]+\d+)?$/u.test(node.text);
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

function collectFunctions(root: SyntaxNode, check: () => void, inherited?: FunctionBodies): FunctionBodies {
	const functions = new Map<string, SyntaxNode[]>();
	for (const [name, bodies] of inherited ?? []) functions.set(name, [...bodies]);
	for (const node of walkNamedNodes(root, check)) {
		if (node.type !== "function_definition") continue;
		const name = requiredField(node, "name").text;
		const bodies = functions.get(name) ?? [];
		bodies.push(requiredField(node, "body"));
		functions.set(name, bodies);
	}
	return functions;
}

async function analyzeFunctionCall(
	facts: CommandFacts,
	context: BashAnalysisContext,
	state: BashAnalysisState,
	check: () => void,
	invocation = context,
): Promise<Paths> {
	const name = facts.program;
	if (name === undefined || state.activeFunctions.has(name)) return [context];
	const definitions = context.plainBindings ? context.definitions.get(name) : state.functions.get(name);
	if (!definitions) return [context];
	state.activeFunctions.add(name);
	const outcomes: Paths = [];
	for (const body of definitions) {
		if (!body) { outcomes.push(context); continue; }
		const functionContext = cloneContext(invocation);
		setPositionalVariables(functionContext.variables, facts.args);
		const traced = invocation === context && traceableBlock(body, context, check);
		if (traced) functionContext.locals = new Map(); else delete functionContext.locals;
		const paths = await analyzeNode(body, [functionContext], state, check);
		if (traced) {
			for (const path of paths) {
				const variables = new Map(path.variables);
				for (const [key, saved] of path.locals ?? []) {
					if (saved === undefined) variables.delete(key); else variables.set(key, saved);
				}
				restorePositionalVariables(variables, context.variables);
				const restored = { ...path, variables };
				if (context.locals) restored.locals = context.locals; else delete restored.locals;
				outcomes.push(restored);
			}
			continue;
		}
		const caller = cloneContext(context);
		invalidateAssignedVariables(body, caller, check, true);
		for (const path of paths) {
			// 位置参数恢复调用者的绑定。嵌套函数已使其失效的普通变量不能恢复。
			const variables = new Map(caller.variables);
			for (const name of variables.keys()) if (!path.variables.has(name) && !isPositionalVariable(name)) variables.delete(name);
			outcomes.push({ ...caller, variables, definitions: path.definitions, plainBindings: caller.plainBindings && path.plainBindings, gitEnvKnown: caller.gitEnvKnown && path.gitEnvKnown, exitTrap: path.exitTrap, cwd: joinDirectories([...caller.cwd, ...path.cwd]) });
		}
	}
	state.activeFunctions.delete(name);
	return joinPaths(outcomes);
}

function handleExitTrap(facts: CommandFacts, context: BashAnalysisContext): void {
	if (facts.program !== "trap" || facts.args.length < 2) return;
	const action = facts.args[0];
	if (typeof action !== "string" || !facts.args.slice(1).some((signal) => signal === "EXIT" || signal === "0")) return;
	context.exitTrap = action === "-" ? undefined : action;
}

async function analyzeExitTraps(paths: Paths, state: BashAnalysisState): Promise<void> {
	for (const context of paths) {
		const action = context.exitTrap;
		if (action === undefined) continue;
		await analyzeScript(action, { ...context, exitTrap: undefined }, state.depth + 1, state, state);
	}
}

function pushUnit(state: BashAnalysisState, unit: ApprovalUnit, source = unit.target.value): void {
	if (state.units.length >= MAX_BASH_UNITS) throw new IncompleteBashAnalysis();
	if (state.depth === 0) unit.source = source;
	state.units.push(unit);
}
