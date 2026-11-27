import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ShellArg } from "../../types.ts";
import { gitScopeVariable } from "../../rules/command-syntax.ts";
import { requiredField, walkCurrentScope, walkNamedNodes } from "./syntax.ts";
import { commandFacts, resolveShellWord, type CommandFacts } from "./command.ts";
import { isOrdinaryVariable } from "./startup.ts";
import { IncompleteBashAnalysis, UNKNOWN_DIRECTORY, UNSET, readVariable, type BashAnalysisContext } from "./branches.ts";
import { MAX_BINDING_LENGTH, allDefined, clearPositionalVariables, plainParameter, positionalValues, setPositionalVariables, shellArgumentValue } from "./state.ts";

export function recordAssignment(node: SyntaxNode, context: BashAnalysisContext): void {
	const lhs = requiredField(node, "name");
	const name = lhs.type === "subscript" ? requiredField(lhs, "name").text : lhs.text;
	if (gitScopeVariable.test(name)) context.gitEnvKnown = false;
	const rhs = node.childForFieldName("value");
	const append = node.children.some(c => c.type === "+=");
	const old = append && context.plainBindings ? plainParameter(name, context) : undefined;
	if (lhs.type !== "variable_name" || ["RANDOM", "BASHPID", "PPID", "UID", "EUID"].includes(name)) { context.variables.delete(name); return; }
	if (rhs?.type === "array") {
		const elements = rhs.namedChildren.filter(n => n.type !== "comment").map(n =>
			["word", "number", "raw_string", "string", "concatenation", "ansi_c_string"].includes(n.type) && !n.text.startsWith("[") ? resolveShellWord(n, context)?.value : undefined);
		const first = elements[0];
		if (!append && context.plainBindings && first !== undefined && allDefined(elements) && !elements.some(e => e.includes("\0"))) {
			context.variables.set(name, { value: first, temporary: false, elements });
		} else context.variables.delete(name);
		return;
	}
	const value = rhs ? resolveShellWord(rhs, context, true, true) : shellArgumentValue("");
	if (value && !append) context.variables.set(name, value);
	else if (old && value && !old.elements && !old.temporary && !old.value.includes("\0") && !value.value.includes("\0")) {
		if (old.value.length + value.value.length > MAX_BINDING_LENGTH) throw new IncompleteBashAnalysis();
		context.variables.set(name, shellArgumentValue(old.value + value.value));
	} else context.variables.delete(name);
}

/** 只在真正执行内建命令时更新状态。循环预分析等不能证明执行的路径只能使旧值失效。 */
function applyBuiltin(facts: CommandFacts, fields: ShellArg[], context: BashAnalysisContext): boolean {
	const { program } = facts;
	if (!context.plainBindings || !program || context.functionNames.has(program)) return false;
	if (program === "set" && fields[0] === "--") { setPositionalVariables(context.variables, fields.slice(1)); return true; }
	if (program === "set") {
		for (let i = 0; i < fields.length; i++) {
			const opt = fields[i];
			if (typeof opt !== "string" || !/^[-+][aefhkmnptuvxBCEHPT]*o?$/u.test(opt) || opt.length === 1) return false;
			if (opt.endsWith("o") && i + 1 < fields.length) {
				const name = fields[++i];
				if (typeof name !== "string" || !/^[a-z]+$/u.test(name)) return false;
			}
		}
		return true;
	}
	if (program === "shift" && fields.length <= 1) {
		const n = fields[0] ?? "1", args = positionalValues(context);
		if (typeof n !== "string" || !/^(?:0|[1-9]\d*)$/u.test(n) || !args) return false;
		if (Number(n) <= args.length) setPositionalVariables(context.variables, args.slice(Number(n)));
		return true;
	}
	if (program === "printf" && fields[0] === "-v" && typeof fields[1] === "string" && isOrdinaryVariable(fields[1]) && fields[2] === "%s") {
		const values = fields.slice(3);
		if (!values.every((v): v is string => typeof v === "string" && !v.includes("\0"))) return false;
		if (values.reduce((size, v) => size + v.length, 0) > MAX_BINDING_LENGTH) throw new IncompleteBashAnalysis();
		if (gitScopeVariable.test(fields[1])) context.gitEnvKnown = false;
		context.variables.set(fields[1], shellArgumentValue(values.join("")));
		return true;
	}
	return false;
}

export function plainDeclaration(node: SyntaxNode): boolean {
	return node.namedChildren.every(child => {
		const name = child.type === "variable_assignment" ? child.childForFieldName("name") : child;
		return name?.type === "variable_name" && !gitScopeVariable.test(name.text);
	});
}

export function updateUnset(node: SyntaxNode, context: BashAnalysisContext, executed: boolean): void {
	const args = node.namedChildren, option = args[0]?.text;
	const names = option === "-v" || option === "-f" ? args.slice(1) : args;
	if (option !== "-v") {
		const definitions = new Map(context.definitions);
		for (const arg of names) {
			const bodies = definitions.get(arg.text);
			if (!bodies) continue;
			if (option === "-f" && executed && context.plainBindings && !context.functionNames.has("unset")) definitions.delete(arg.text);
			else definitions.set(arg.text, [...new Set([...bodies, undefined])]);
		}
		context.definitions = definitions;
	}
	if (option === "-f") return;
	if (names.some(arg => arg.type !== "variable_name")) { context.variables.clear(); return; }
	for (const arg of names) {
		if (executed && !context.functionNames.has("unset") && (/^[a-z_][a-z0-9_]*$/u.test(arg.text) || arg.text === "CDPATH")) context.variables.set(arg.text, UNSET);
		else context.variables.delete(arg.text);
	}
}

export function invalidateCommandState(facts: CommandFacts, context: BashAnalysisContext, fields?: ShellArg[]): void {
	const program = facts.program;
	const otherTrap = program === "trap" && facts.args.slice(1).some(arg => arg !== "EXIT" && arg !== "0");
	if (!program || otherTrap || [".", "source", "eval", "alias", "enable", "declare", "typeset", "readonly", "shopt", "unset"].includes(program)) context.plainBindings = false;
	if (!program || otherTrap || ["eval", "source", ".", "export", "declare", "typeset", "local", "readonly", "alias", "enable"].includes(program)
		|| program === "set" && facts.args.some(arg => typeof arg !== "string" || arg === "allexport" || /^-[^-]*a/u.test(arg))) context.gitEnvKnown = false;
	if (fields && applyBuiltin(facts, fields, context)) return;
	if (program === "builtin" || program === "command") {
		const [name, ...args] = facts.args;
		if (typeof name === "string" && !name.startsWith("-") && name !== "builtin" && name !== "command") invalidateCommandState({ program: name, args }, context);
		else { context.gitEnvKnown = false; context.plainBindings = false; }
		return;
	}
	if (program === "eval" || program === "source" || program === ".") { context.variables.clear(); context.cwd = [UNKNOWN_DIRECTORY]; return; }
	if (program === "pushd" || program === "popd") { context.cwd = [UNKNOWN_DIRECTORY]; return; }
	if (program === "shift" || program === "set" && facts.args.length) {
		clearPositionalVariables(context.variables); return;
	}
	const forget = (arg: ShellArg | undefined) => {
		if (typeof arg !== "string") { context.variables.clear(); return; }
		const name = /^([a-zA-Z_]\w*)(?:\[.*\])?$/su.exec(arg)?.[1];
		if (name) context.variables.delete(name);
	};
	if (program === "read" || program === "readarray" || program === "mapfile" || program === "unset") {
		for (const arg of facts.args) forget(arg);
	} else if (program === "getopts") forget(facts.args[1]);
	else if (program === "printf") {
		const option = facts.args.indexOf("-v");
		if (option >= 0) forget(facts.args[option + 1]);
	}
}

export function expansionWrite(node: SyntaxNode, context: BashAnalysisContext): string | undefined {
	if (!["expansion", "binary_expression", "postfix_expression", "unary_expression"].includes(node.type)) return;
	const operator = node.children.find(c => !c.isNamed && /^(?:[+*/%&|^-]?=|:=|\+\+|--)$/u.test(c.type));
	if (!operator) return;
	const lhs = node.firstNamedChild;
	if (node.type === "expansion" && lhs?.type === "variable_name") {
		const bound = readVariable(lhs.text, context);
		if (bound && bound !== UNSET && !("choices" in bound) && (operator.type === "=" || bound.value !== "" && !bound.value.includes("\0"))) return;
	}
	return lhs?.type === "variable_name" ? lhs.text : lhs?.type === "subscript" ? lhs.childForFieldName("name")?.text : undefined;
}

export function invalidateAssignedVariables(node: SyntaxNode, context: BashAnalysisContext, check: () => void, functionScope = false): void {
	for (const candidate of walkCurrentScope(node, check)) {
		if (candidate.type === "declaration_command" && !plainDeclaration(candidate)) context.gitEnvKnown = false;
		const lhs = candidate.type === "variable_assignment" ? candidate.childForFieldName("name") : null;
		const name = lhs?.type === "subscript" ? lhs.childForFieldName("name")?.text : lhs?.text ?? expansionWrite(candidate, context);
		if (name) { context.variables.delete(name); if (gitScopeVariable.test(name)) context.gitEnvKnown = false; }
		if (candidate.type === "for_statement") context.variables.delete(requiredField(candidate, "variable").text);
		if (candidate.type === "unset_command") updateUnset(candidate, context, false);
		if (candidate.type === "command") {
			const facts = commandFacts(candidate, context);
			if (functionScope && (facts.program === "set" || facts.program === "shift")) continue;
			invalidateCommandState(facts, context);
		}
	}
}

const normalCommands = new Set([":", "true", "false", "echo", "printf", "set", "shift", "cd", "test"]);
const transparentNodes = new Set(["compound_statement", "do_group", "if_statement", "elif_clause", "else_clause", "list", "redirected_statement", "file_redirect", "file_descriptor", "command_name", "test_command", "binary_expression", "unary_expression", "word", "string", "raw_string", "ansi_c_string", "string_content", "concatenation", "number", "variable_name", "simple_expansion", "comment"]);

/** 可用正常完成时的状态继续分析。跳转、调用未知代码或修改变量属性的块仍需合并其他出口。 */
export function traceableBlock(body: SyntaxNode, context: BashAnalysisContext, check: () => void): boolean {
	if (!context.plainBindings || !["compound_statement", "do_group"].includes(body.type)) return false;
	for (const node of walkNamedNodes(body, check)) {
		if (node.nextSibling?.type === "&") return false;
		if (node.type === "command") {
			const name = node.childForFieldName("name")?.text;
			if (!name || !normalCommands.has(name) || context.functionNames.has(name)) return false;
		} else if (node.type === "declaration_command") {
			if (node.parent?.id !== body.id || node.firstChild?.type !== "local" || context.functionNames.has("local") || !node.namedChildren.every(n => n.type === "variable_assignment")) return false;
		} else if (node.type === "variable_assignment") {
			if (!isOrdinaryVariable(node.childForFieldName("name")?.text ?? "")) return false;
		} else if (node.type === "expansion") {
			if (!/^\$\{(?:[a-z_]\w*|\d+)\}$/iu.test(node.text)) return false;
		} else if (!transparentNodes.has(node.type)) return false;
	}
	return true;
}

export function literalTest(node: SyntaxNode): boolean | undefined {
	const expr = node.firstNamedChild;
	if (node.type !== "test_command" || node.firstChild?.type !== "[[" || expr?.type !== "binary_expression") return;
	const [left, op, right] = expr.children;
	if (!left || !op || !right || !["=", "==", "!="].includes(op.type) || ![left, right].every(n => /^[a-zA-Z0-9_./-]+$/u.test(n.text))) return;
	// 未知的 nocasematch 只影响仅大小写不同的字符串。
	if (left.text !== right.text && left.text.toLowerCase() === right.text.toLowerCase()) return;
	return op.type === "!=" ? left.text !== right.text : left.text === right.text;
}
