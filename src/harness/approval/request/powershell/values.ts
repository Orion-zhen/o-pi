import { staticPowerShellWord } from "../../../syntax-tree/powershell.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import { choices, lookup, variable, variableType, type Binding, type Environment, type Flow } from "./flow.ts";
import { expandedString, MAX_STRING_LENGTH } from "./interpolation.ts";
import { CHOICE_LIMIT, IncompletePowerShellAnalysis } from "./locations.ts";

const layers = new Set(["pipeline", "pipeline_chain", "left_assignment_expression", "array_literal_expression", "unary_expression", "string_literal",
	"command_name_expr", "path_command_name", "argument_expression_list", "argument_expression",
	...["logical", "bitwise", "comparison", "additive", "multiplicative", "format", "range"].flatMap(name => [`${name}_expression`, `${name}_argument_expression`])]);
export function unwrap(node: SyntaxNode): SyntaxNode {
	while (layers.has(node.type)) {
		const child = node.firstNamedChild;
		if (!child || node.childCount !== 1 || node.startIndex !== child.startIndex || node.endIndex !== child.endIndex) break;
		node = child;
	}
	return node;
}

function quotedString(node: SyntaxNode): boolean {
	return ["verbatim_string_characters", "expandable_string_literal", "verbatim_here_string_characters", "expandable_here_string_literal"].includes(node.type);
}

function createsGuid(node: SyntaxNode): boolean {
	if (node.type !== "invokation_expression") return false;
	const [type, op, member, args] = node.children;
	return type?.type === "type_literal" && /^\[(?:system\.)?guid\]$/iu.test(type.text) && op?.text === "::"
		&& member?.text.toLowerCase() === "newguid" && args?.namedChildCount === 0;
}

/** 只判断方法本身。接收方和参数仍按表达式检查，不推断方法的返回值。 */
export function dataMethod(node: SyntaxNode, flow: Flow): boolean {
	if (flow.uncertain === "bindings" || node.type !== "invokation_expression") return false;
	if (createsGuid(node)) return true;
	const [receiver, op, member] = node.children;
	if (!receiver || op?.text !== "." || member?.firstNamedChild?.type !== "simple_name") return false;
	const value = unwrap(receiver.type === "parenthesized_expression" && receiver.firstNamedChild ? receiver.firstNamedChild : receiver);
	// Where 和 ForEach 能执行回调，不按字符串方法处理。
	if (quotedString(value)) return !/^(?:where|foreach)$/iu.test(member.text);
	return member.text.toLowerCase() === "tostring" && createsGuid(value);
}

function stringAtom(node: SyntaxNode, flow: Flow): boolean {
	if (node.type === "generic_token" && /^[a-z_./\\]/iu.test(node.text)) return true;
	if (quotedString(node)) return true;
	if (node.type !== "variable" && node.type !== "braced_variable") return false;
	return variableType(node.text, flow) === "string";
}

// PowerShell 的 + 也能用于数字和数组。仅拼接每个操作数都明确为字符串的表达式。
function concatenate(node: SyntaxNode, flow: Flow, env: Environment, depth: number): Binding | undefined {
	if (node.childCount !== 3) return;
	const [left, op, right] = node.children;
	if (!left || op?.text !== "+" || !right) return;
	const lhs = scalar(left, flow, env, depth + 1), rhs = scalar(right, flow, env, depth + 1);
	if (lhs?.type !== "string" || rhs?.type !== "string") return;
	if (lhs.values.length * rhs.values.length > CHOICE_LIMIT) return { type: "string", values: [undefined] };
	return { type: "string", values: choices(lhs.values.flatMap(a => rhs.values.map(b => {
		if (a === undefined || b === undefined) return undefined;
		if (a.length + b.length > MAX_STRING_LENGTH) throw new IncompletePowerShellAnalysis();
		return a + b;
	}))) };
}

/** undefined 表示不是支持的标量表达式，数组内的 undefined 表示标量的值不确定。 */
export function scalar(expression: SyntaxNode, flow: Flow, env: Environment, depth = 0): Binding | undefined {
	if (depth > 32) throw new IncompletePowerShellAnalysis();
	const node = unwrap(expression);
	if (node.type === "additive_expression" || node.type === "additive_argument_expression") return concatenate(node, flow, env, depth);
	if (node.type === "parenthesized_expression" && node.childCount === 3 && node.firstNamedChild) {
		return scalar(node.firstNamedChild, flow, env, depth + 1);
	}
	const literal = staticPowerShellWord(node);
	if (literal !== undefined) return { values: [literal], type: stringAtom(node, flow) ? "string" : "unknown" };
	if (node.type === "variable" || node.type === "braced_variable") {
		if (variable(node.text) || /^\$(?:true|false)$/iu.test(node.text)) return { values: lookup(node.text, flow, env), type: variableType(node.text, flow) };
		return;
	}
	if (node.type === "element_access") {
		const index = /^\$args\[(0|[1-9]\d*)\]$/iu.exec(node.text)?.[1];
		if (index === undefined) return;
		const values = flow.args[Number(index)] ?? [undefined];
		return { type: "unknown", values: flow.uncertain ? choices([...values, undefined]) : values };
	}
	return expandedString(node, flow, env, expr => scalar(expr, flow, env, depth + 1));
}

/** 只折叠会缩小目标范围的常量和已知字符串比较。其他条件检查两条分支。 */
export function conditionValue(expression: SyntaxNode, flow: Flow, env: Environment): boolean | undefined {
	const node = unwrap(expression);
	if (node.text.toLowerCase() === "$true") return true;
	if (node.text.toLowerCase() === "$false") return false;
	if (node.type !== "comparison_expression") return;
	const [left, op, right] = node.namedChildren;
	if (!left || !right || !op) return;
	if (!/^-[ci]?(?:eq|ne)$/iu.test(op.text)) return;
	const lhsNode = unwrap(left);
	if (flow.uncertain || !stringAtom(lhsNode, flow)) return;
	const lhs = scalar(left, flow, env)?.values, rhs = scalar(right, flow, env)?.values;
	if (!lhs || !rhs) return;
	const outcomes = new Set<boolean>();
	for (const a of lhs) for (const b of rhs) {
		if (a === undefined || b === undefined || !/^[\w./ -]*$/u.test(a) || !/^[\w./ -]*$/u.test(b)) return;
		const equal = /^-c/iu.test(op.text) ? a === b : a.toLowerCase() === b.toLowerCase();
		outcomes.add(/ne$/iu.test(op.text) ? !equal : equal);
	}
	return outcomes.size === 1 ? outcomes.has(true) : undefined;
}

/** 仅展开无语句副作用的有限标量列表。 */
export function loopValues(expression: SyntaxNode, flow: Flow, env: Environment): Binding[] | undefined {
	let node = unwrap(expression);
	if (node.type === "array_expression") {
		const statements = node.childForFieldName("statements");
		const child = statements?.firstNamedChild;
		if (!child || statements?.namedChildCount !== 1) return;
		node = unwrap(child);
	}
	const items = node.type === "array_literal_expression" ? node.namedChildren : [node];
	if (items.length > CHOICE_LIMIT) return;
	const values = items.map(item => scalar(item, flow, env));
	if (values.every((v): v is Binding => v !== undefined && !v.values.includes(undefined))) return values;
}
