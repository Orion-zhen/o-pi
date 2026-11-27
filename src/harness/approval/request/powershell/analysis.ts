import path from "node:path";
import { powerShellCodeInput, powerShellCommand, powerShellRedirect, staticPowerShellWord, type PowerShellRedirect, type PowerShellWord } from "../../../syntax-tree/powershell.ts";
import type { SyntaxNode, SyntaxTreeDocument } from "../../../syntax-tree/types.ts";
import type { ShellArgv } from "../../types.ts";
import { argumentsFor, changesCommandBindings, modeledCmdlets, outputVariables, standalone, temporaryCommand, wordValues, writesSessionState } from "./commands.ts";
import { callbacks, forEach, scoped, statementBlock, tryStatement, type Branch, type Evaluation, type Execution } from "./control.ts";
import { cmdInput } from "./cmd-input.ts";
import { pathResult } from "./queries.ts";
import { fileRead } from "./file-read.ts";
import { bindFunction, collectFunctions, declareFunction, visibleFunctions } from "./functions.ts";
import { CHOICE_LIMIT, filePath, IncompletePowerShellAnalysis, locationChange, locations, type Location } from "./locations.ts";
import { assign, fork, invalidate, merge, variable, type Binding, type Flow, type Scalar } from "./flow.ts";
import { INPUT_LIMIT, pushUnit, writeRedirect, type AnalysisState, type ScriptInput } from "./units.ts";
import { conditionValue, dataMethod, loopValues, scalar, unwrap } from "./values.ts";

interface CommandResult { commands: ShellArgv[]; output: Binding | undefined }

export function analyzePowerShell(tree: SyntaxTreeDocument, input: ScriptInput, state: AnalysisState, script: string): void {
	const { pipelines, pending, env } = state;
	const { code: source } = input;
	const { check } = tree.control;
	const active = new Set<number>();
	const processCwd = input.depth === 0 ? input.flow.positions[0]?.[0] : undefined;

	function describe(reason: string, start: number, end: number) {
		const location = ` at ${source.slice(0, start).split("\n").length}:${start - source.lastIndexOf("\n", start - 1)}`;
		const snippet = !input.depth && source === state.display ? source.slice(start, Math.min(end, start + 80)) : undefined;
		return `${input.depth ? "Nested PowerShell: " : ""}${reason}${location}${snippet ? `: ${snippet}` : "."}`;
	}
	function opaque(node: SyntaxNode, reason: string) {
		pushUnit(state, { action: "execute", target: { kind: "command", value: node.text }, remember: false,
			analysisFact: "shell.run-opaque-input", analysisNote: describe(reason, node.startIndex, node.endIndex) });
	}

	function* visitChildren(node: SyntaxNode, branch: Branch, depth: number): Execution {
		for (const child of node.namedChildren) if (!(yield* visit(child, branch, depth + 1))) return;
		return branch.flow;
	}

	function redirect(word: PowerShellRedirect, flow: Flow): void {
		if ("attachedOperand" in word) {
			// 紧贴操作符的目标在主语法树中是单一 token。用同一语法解析其标量，不把目标作为脚本访问。
			if (pending.length >= INPUT_LIMIT) { writeRedirect({ source: word.source, value: undefined }, flow, input.depth, state); return; }
			pending.push({ kind: "redirect", code: word.attachedOperand, source: word.source, depth: input.depth, flow: fork(flow, "detached") });
			return;
		}
		writeRedirect(word, flow, input.depth, state);
	}

	function* invoke(body: SyntaxNode, words: PowerShellWord[], variants: Scalar[][], parent: Branch, depth: number, dot: boolean): Execution {
		if (active.has(body.id)) { opaque(body, "Recursive function call"); invalidate(parent.flow); return parent.flow; }
		active.add(body.id);
		const child = { flow: fork(parent.flow), inLoop: dot && parent.inLoop };
		function* call(): Execution {
			child.flow.independent = false;
			const strings = words.map(w => w.expression !== undefined && scalar(w.expression, parent.flow, env)?.type === "string");
			const block = body.namedChildren.find(n => n.type === "script_block");
			if (!bindFunction(body, words, variants, strings, child.flow)) {
				invalidate(child.flow);
				const params = body.namedChildren.find(n => n.type === "function_parameter_declaration") ?? block?.namedChildren.find(n => n.type === "param_block");
				if (params) yield* embedded(params, child, depth + 1);
			}
			return block ? yield* visit(block, child, depth) : child.flow;
		}
		const next = yield* scoped(dot ? "current" : "function", parent.flow, call());
		active.delete(body.id);
		return next;
	}

	function* command(node: SyntaxNode, branch: Branch, depth: number, piped: boolean): Evaluation<CommandResult> {
		const { flow } = branch;
		yield ["error", flow];
		const { operator, name, args: rawArgs, redirects, hasRedirection } = powerShellCommand(node, script, check);
		const literalName = name.value?.toLowerCase();
		const literalFunction = literalName === undefined ? undefined : visibleFunctions(literalName, flow.functions);
		const cmdletName = literalName === "select" ? "select-object" : literalName;
		const unshadowed = cmdletName !== undefined && flow.uncertain !== "bindings" && !literalFunction?.bodies.length
			&& (cmdletName === literalName || !visibleFunctions(cmdletName, flow.functions).bodies.length);
		const direct = unshadowed && !operator;
		const cmdlet = direct && modeledCmdlets.has(cmdletName);
		const bind = cmdlet || !flow.uncertain && literalFunction?.definite;
		const args = bind ? rawArgs.flatMap(a => a.kind === "parameter" ? [a.name, a.argument] : [a]) : rawArgs;
		// 未识别的命令仍可能绑定公共参数。只有已识别且未被重定义的原生程序不会写输出变量。
		const native = unshadowed && operator !== "." && /(?:\.(?:exe|com|cmd|bat)$|^(?:bun|node|git|pwsh|powershell)$)/u.test(cmdletName);
		const outputs = native ? [] : outputVariables(rawArgs, flow, env);
		const names = wordValues(name, flow, env);
		const keys = names.flatMap(n => n ? [n.toLowerCase()] : []);
		if (keys.includes("select") && !keys.includes("select-object")) keys.push("select-object");
		const variants = argumentsFor(args, flow, env, Math.floor(CHOICE_LIMIT / Math.max(1, keys.length)));
		const commands: ShellArgv[] = [];
		if (name.value && rawArgs.some(arg => arg.value === undefined)) {
			const operands = rawArgs.map(arg => arg.value ?? { source: arg.source });
			for (const key of keys) commands.push([path.win32.basename(key), ...operands]);
		}
		const plain = direct && !hasRedirection;
		const paths = plain && !flow.uncertain && !piped ? pathResult(cmdletName, args, variants, flow) : undefined;
		const guid = paths?.guidOperand;
		const modeledArgs = args.map((arg, i) => {
			if (i === guid?.index) return { source: arg.source, guidPrefix: guid.prefix };
			if (cmdlet && arg.kind === "list") {
				const elements = arg.elements.map(word => word.value);
				if (elements.every(value => value !== undefined)) return { source: arg.source, elements };
			}
		});
		let reason = names.some(n => !n) || operator === "." ? describe("Dynamic command or script", name.start, name.end) : undefined;
		let argumentNote: string | undefined;
		let simple = !reason && !flow.uncertain && !redirects.length;
		const movements: Location[] = [], bodies = new Map<number, SyntaxNode>();
		const literalArgs = args.every(a => a.value !== undefined);
		const codeInputs = { expression: new Set<string>(), child: new Set<string>(), "static-child": new Set<string>() };
		let changesBindings = false;
		const before = flow.positions;
		let changesState = !literalName || operator === ".", stays = false, allTemporary = !input.depth && simple && node.parent?.text.trim() === node.text.trim();
		for (const key of keys) {
			if (/[/\\:]/u.test(key) && flow.positions.some(([cwd]) => cwd === undefined) && filePath(key, undefined) === undefined) reason ??= describe("Unresolved executable path", name.start, name.end);
			const { bodies: definitions, definite } = visibleFunctions(key, flow.functions);
			const local = definitions.length === 1 && definite && !flow.uncertain;
			changesBindings ||= definitions.length > 0 && !local;
			for (const body of definitions) bodies.set(body.id, body);
			for (const values of variants) {
				commands.push([path.win32.basename(key), ...args.map((arg, i) => values[i] ?? modeledArgs[i] ?? { source: arg.source, unresolved: true as const })]);
				if (!local) {
					const inner = cmdInput(key, args, values, flow.positions);
					commands.push(...inner);
					if (inner.some(argv => argv.some(arg => typeof arg !== "string"))) simple = false;
				}
				const code = powerShellCodeInput(key, args, values);
				const staticChild = plain && literalArgs && code?.mode === "child" && code.staticScript;
				if (code) simple = false;
				const unresolved = args.find((_, i) => values[i] === undefined && !modeledArgs[i]);
				if (unresolved) {
					argumentNote ??= describe("Unresolved argument", unresolved.start, unresolved.end);
					if (key === "new-item") reason ??= argumentNote;
				}
				if (code && !staticChild) reason ??= describe("Unresolved script input", node.startIndex, node.endIndex);
				if (code?.script !== undefined) codeInputs[staticChild ? "static-child" : code.mode].add(code.script);
				if (changesCommandBindings(key, values)) {
					changesBindings = true;
					reason ??= describe("Command bindings may change", name.start, name.end);
				}
				changesBindings ||= key.endsWith(".ps1") || /(?:^|\\)update-typedata$/u.test(key);
				const next = locationChange(key, values, flow.positions);
				if (next) movements.push(...next);
				else stays = true;
				changesState ||= code?.mode === "expression" || writesSessionState(key, values, flow);
				allTemporary &&= !definitions.length && !code && temporaryCommand(key, values, args, flow, env);
			}
		}
		const analysisNote = reason ?? argumentNote;
		simple &&= !reason && !bodies.size && name.value !== undefined && literalArgs;
		pushUnit(state, { action: "execute", target: { kind: "command", value: source.slice(node.startIndex, node.endIndex).trim() }, commands,
			remember: simple && !input.depth && standalone(node) && flow.independent,
			...(reason && { analysisFact: "shell.run-opaque-input" }), ...(analysisNote && { analysisNote }),
			...(allTemporary && !reason && { effect_scope: "temporary" }) });
		for (const target of paths?.directories ?? []) {
			pushUnit(state, { action: "create_directory", target,
				...(!input.depth && source === state.display && { source: node.text.trim() }), remember: false });
		}
		for (const child of node.namedChildren) yield* embedded(child, branch, depth + 1);
		for (const target of redirects) redirect(target, branch.flow);
		children: for (const [mode, scripts] of Object.entries(codeInputs)) for (const code of scripts) {
			if (input.depth >= 8 || pending.length >= INPUT_LIMIT) { opaque(node, "Nested script limit reached"); break children; }
			const child = fork(branch.flow, mode === "expression" ? "detached" : "process");
			if (mode !== "static-child") invalidate(child);
			pending.push({ kind: "script", code, depth: input.depth + 1, flow: child });
		}
		if (bodies.size) {
			const completed: Flow[] = [];
			for (const body of bodies.values()) {
				const normal = yield* invoke(body, args, variants, branch, depth, operator === ".");
				if (normal) completed.push(normal);
			}
			// 默认别名可能优先于本地函数，调用者的路径也可能继续。
			branch.flow = merge(branch.flow, ...completed);
		}
		const after = branch.flow;
		if (movements.length) {
			if (stays) movements.push(...before);
			if (changesState || bodies.size || after.positions !== before) movements.push(...after.positions);
			after.positions = locations(movements);
			after.independent = false;
		}
		for (const name of outputs) {
			if (!name || !/^\w+$/u.test(name)) { changesState = true; continue; }
			// 写入可能失败，已知旧值和新产生的未知值都要保留。
			const previous = after.locals.get(name);
			if (previous) after.locals.set(name, { type: "unknown", values: [...new Set([...previous.values, undefined])] });
			after.independent = false;
		}
		if (changesBindings || changesState) invalidate(after, changesBindings || !keys.length || operator === "." ? "bindings" : "state");
		return { commands, output: paths?.output };
	}

	function guard(depth: number) { check(); if (depth > 96) throw new IncompletePowerShellAnalysis(); }
	function* embedded(node: SyntaxNode, branch: Branch, depth: number): Evaluation<void> {
		guard(depth);
		if (/^(?:pre|post)_(?:increment|decrement)_expression$/u.test(node.type)) invalidate(branch.flow);
		if (node.type === "script_block_expression") {
			const normal = yield* callbacks(branch.flow, child => visitChildren(node, child, depth));
			if (normal) branch.flow = normal;
			return;
		}
		if (node.type === "pipeline" && unwrap(node).type === "script_block_expression") {
			yield* embedded(unwrap(node), branch, depth + 1); return;
		}
		if (["command", "pipeline", "statement_list", "invokation_expression", "stop_parsing", "verbatim_command_argument"].includes(node.type)) {
			yield* visit(node, branch, depth + 1); return;
		}
		for (const child of node.namedChildren) yield* embedded(child, branch, depth + 1);
	}

	function* conditional(node: SyntaxNode, branch: Branch, depth: number): Execution {
		const elseif = node.childForFieldName("elseif_clauses");
		const completed: Flow[] = [];
		branch.flow.independent = false;
		for (const clause of [node, ...elseif?.namedChildren.filter(n => n.type === "elseif_clause") ?? []]) {
			const condition = clause.childForFieldName("condition"), body = statementBlock(clause);
			if (!condition) throw new Error("Missing PowerShell condition field.");
			const selected = conditionValue(condition, branch.flow, env);
			if (selected === false) continue;
			if (completed.length >= CHOICE_LIMIT) throw new IncompletePowerShellAnalysis();
			if (selected === undefined) { yield* visit(condition, branch, depth + 1); yield ["error", branch.flow]; }
			const taken = selected === true ? branch : { ...branch, flow: fork(branch.flow) };
			const normal = yield* visit(body, taken, depth + 1);
			if (normal) completed.push(normal);
			if (selected === true) return finish();
		}
		const otherwise = node.childForFieldName("else_clause");
		const last = otherwise ? yield* visit(otherwise, branch, depth + 1) : branch.flow;
		if (last) completed.push(last);
		return finish();

		function finish(): Flow | undefined {
			const [first, ...rest] = completed;
			if (!first) return;
			branch.flow = merge(first, ...rest);
			return branch.flow;
		}
	}

	function* pipeline(node: SyntaxNode, branch: Branch, depth: number): Evaluation<ShellArgv[]> {
		guard(depth);
		const [first, ...tail] = node.namedChildren.filter(n => n.type !== "pipeline_chain_tail" && n.type !== "comment");
		if (!first) return [];
		if (first.type === "assignment_expression") { yield* visit(first, branch, depth + 1); return []; }
		const head = yield* pipelineChain(first, branch, depth + 1);
		for (const part of tail) {
			const taken = { ...branch, flow: fork(branch.flow) };
			yield* pipelineChain(part, taken, depth + 1);
			branch.flow = merge(branch.flow, taken.flow);
		}
		return head;
	}

	function* inspectRead(expr: SyntaxNode, branch: Branch, depth: number): Evaluation<ReturnType<typeof fileRead>> {
		const read = fileRead(expr, branch.flow, env, processCwd);
		if (read) {
			pushUnit(state, { action: "execute", target: { kind: "command", value: expr.text }, commands: read.commands, remember: false });
			yield* embedded(read.operand, branch, depth + 1);
			yield ["error", branch.flow];
		}
		return read;
	}

	function* pipelineChain(node: SyntaxNode, branch: Branch, depth: number): Evaluation<ShellArgv[]> {
		guard(depth);
		const stages: ShellArgv[][] = [];
		for (const child of node.namedChildren) {
			if (child.type === "comment") continue;
			if (child.type === "command") {
				const result: CommandResult = yield* command(child, branch, depth + 1, stages.length > 0);
				stages.push(result.commands);
			} else {
				const expr = unwrap(child);
				const group = expr.type === "parenthesized_expression" ? expr.firstNamedChild : null;
				const read = yield* inspectRead(expr, branch, depth);
				if (read) stages.push(read.commands);
				else if (group?.type === "pipeline") stages.push(yield* pipeline(group, branch, depth + 1));
				else {
					yield* visit(child, branch, depth + 1);
					if (child.type !== "redirections" && child.type !== "verbatim_command_argument") stages.push([]);
				}
			}
		}
		if (stages.length > 1) pipelines.push({ stages, unit: { action: "execute", target: { kind: "command", value: source.slice(node.startIndex, node.endIndex).trim() }, remember: false } });
		return stages.at(-1) ?? [];
	}

	function* visit(node: SyntaxNode, branch: Branch, depth: number): Execution {
		guard(depth);
		const { flow } = branch;
		const expression = unwrap(node);
		if (staticPowerShellWord(expression) !== undefined) return flow;
		if (expression.type === "command") { yield* command(expression, branch, depth + 1, false); return branch.flow; }
		if (expression.type === "assignment_expression") {
			const [left, op, right] = expression.namedChildren;
			const key = left && variable(left.text);
			if (key && op?.text === "=" && right) {
				yield ["error", flow];
				const rhs = unwrap(right);
				let binding;
				if (rhs.type === "command") {
					const result = yield* command(rhs, branch, depth + 1, false);
					binding = result.output;
				} else binding = (yield* inspectRead(rhs, branch, depth))?.output ?? scalar(rhs, flow, env);
				if (!binding && rhs.type !== "command") yield* visit(right, branch, depth + 1);
				assign(branch.flow, key, binding ?? { values: [undefined], type: "unknown" }); branch.flow.independent = false;
				return branch.flow;
			}
		}
		switch (node.type) {
			case "function_statement": yield ["error", flow]; declareFunction(node, flow.functions, !flow.uncertain); return flow;
			case "try_statement":
				flow.independent = false;
				return yield* tryStatement(node, branch, (block, child) => visit(block, child, depth + 1));
			case "script_block_expression": case "comment": case "empty_statement": case "pipeline_chain_tail": return flow;
			case "param_block":
				if (!active.size) { invalidate(flow); yield* embedded(node, branch, depth + 1); }
				return branch.flow;
			case "if_statement": return yield* conditional(node, branch, depth);
			case "flow_control_statement": {
				const keyword = node.firstChild?.type;
				if (keyword === "break" || keyword === "continue") {
					if (branch.inLoop && !node.namedChildCount) { yield [keyword, flow]; return; }
					yield ["loopJump", flow];
				}
				if (keyword === "return" || keyword === "throw") {
					for (const child of node.namedChildren) yield* visit(child, branch, depth + 1);
					yield [keyword === "throw" ? "error" : "return", branch.flow]; return;
				}
				if (keyword !== "exit") break;
				const argument = node.firstNamedChild;
				const value = argument ? staticPowerShellWord(unwrap(argument)) : undefined;
				if (argument && value === undefined) yield* visit(argument, branch, depth + 1);
				const commands: ShellArgv[] = argument ? wordValues({ expression: argument, value }, branch.flow, env)
					.map(v => ["exit", v ?? { source: argument.text, unresolved: true }]) : [["exit"]];
				pushUnit(state, { action: "execute", target: { kind: "command", value: node.text }, commands, remember: false });
				yield ["exit", branch.flow];
				// 参数求值可能失败，保留异常和继续执行的路径，不推断退出码类型。
				if (argument && value === undefined) { yield ["error", branch.flow]; return branch.flow; }
				return;
			}
			case "foreach_statement": {
				const [v, seq, body] = node.namedChildren, key = v && variable(v.text);
				const items = seq && loopValues(seq, flow, env);
				if (!key || !items || !body) break;
				flow.independent = false;
				return yield* forEach(key, items, branch, iteration => visit(body, iteration, depth + 1));
			}
			case "pipeline": yield* pipeline(node, branch, depth); return branch.flow;
			case "pipeline_chain": yield* pipelineChain(node, branch, depth); return branch.flow;
			case "redirection": {
				yield ["error", flow]; yield* embedded(node, branch, depth + 1);
				const target = powerShellRedirect(node); if (target) redirect(target, branch.flow);
				return branch.flow;
			}
			case "program": case "statement_list": case "statement_block": case "else_clause": case "script_block_body": case "script_block": case "redirections":
				return yield* visitChildren(node, branch, depth);
			case "invokation_expression":
				if (yield* inspectRead(node, branch, depth)) return branch.flow;
				if (!dataMethod(node, flow)) { opaque(node, "Uninspected method call"); invalidate(flow); }
				break;
			case "verbatim_command_argument": case "stop_parsing": opaque(node, "Verbatim command input"); break;
			case "assignment_expression": invalidate(flow); break;
		}
		if (["foreach_statement", "for_statement", "while_statement", "do_statement", "switch_statement"].includes(node.type)) {
			invalidate(flow);
			const nested = { flow, inLoop: false };
			collectFunctions(node.namedChildren, flow.functions, check);
			const before = fork(flow);
			for (const child of node.namedChildren) yield* visit(child, nested, depth + 1);
			branch.flow = merge(before, nested.flow); return branch.flow;
		}
		// 求值可能失败，但未知值不是审批事实。继续检查表达式里的调用。
		yield ["error", flow];
		for (const child of node.namedChildren) yield* embedded(child, branch, depth + 1);
		return branch.flow;
	}
	for (const _ of visit(tree.root, { flow: input.flow, inLoop: false }, 0)) { /* 顶层出口没有后继。 */ }
}
