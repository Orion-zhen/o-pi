import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import { choices, lookup, variable, variableType, type Binding, type Environment, type Flow, type Scalar } from "./flow.ts";
import { CHOICE_LIMIT, IncompletePowerShellAnalysis } from "./locations.ts";

export const MAX_STRING_LENGTH = 65536;
type Part = string | { token: string } | { value: Binding; id: number };

/** 一次无副作用的插值只读取每个变量一次。不同位置沿用同一个候选。 */
function interpolate(parts: Part[], flow: Flow, env: Environment): Binding {
	const slots = new Map<string | number, Scalar[]>();
	let type: Binding["type"] = "string";
	const pieces = parts.map(part => {
		if (typeof part === "string") return part;
		if ("value" in part) { slots.set(part.id, part.value.values); return { id: part.id }; }
		const key = variable(part.token);
		const id = key ? `${key.scope}:${key.name}` : part.token.toLowerCase();
		if (!slots.has(id)) {
			const values = lookup(part.token, flow, env, true);
			if (values.includes(undefined) && variableType(part.token, flow) === "unknown") type = "unknown";
			slots.set(id, values);
		}
		return { id };
	});
	let rows = [new Map<string | number, Scalar>()];
	for (const [id, values] of slots) {
		if (rows.length * values.length > CHOICE_LIMIT) return { type, values: [undefined] };
		if (values.length === 1) for (const row of rows) row.set(id, values[0]);
		else rows = rows.flatMap(row => values.map(v => new Map(row).set(id, v)));
	}
	return { type, values: choices(rows.map(row => {
		let result = "";
		for (const part of pieces) {
			const s = typeof part === "string" ? part : row.get(part.id);
			if (s === undefined) return;
			if (s.length + result.length > MAX_STRING_LENGTH) throw new IncompletePowerShellAnalysis();
			result += s;
		}
		return result;
	})) };
}

function bareParts(text: string): Part[] | undefined {
	if (!text.includes("$") || !/^[\p{L}\p{N}./_\\-]/u.test(text) && !/^\$(?:env:)?[a-z_]\w*(?:\/[\w.-]+)+$/iu.test(text)) return;
	const pieces: Part[] = [];
	const token = /[\p{L}\p{N}_.:/\\*?@%+=-]+|\$(?:\{(?:env:)?[a-z_]\w*\}|(?:env:)?[a-z_]\w*(?=$|[/\\.$-]))/iuy;
	while (token.lastIndex < text.length) {
		const part = token.exec(text)?.[0];
		if (!part) return;
		pieces.push(part.startsWith("$") ? { token: part } : part);
	}
	return pieces;
}

export function expandedString(node: SyntaxNode, flow: Flow, env: Environment, evaluate: (expr: SyntaxNode) => Binding | undefined): Binding | undefined {
	const text = node.text;
	if (node.type === "generic_token") {
		const parts = bareParts(text);
		return parts && interpolate(parts, flow, env);
	}
	let pos = 1, end = text.length - 1;
	if (node.type === "verbatim_here_string_characters" || node.type === "expandable_here_string_literal") {
		const body = /^@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n\1@$/u.exec(text)?.[2];
		if (body === undefined || /\r(?!\n)|^[\u2018-\u201e]@/mu.test(text)) return;
		if (node.type === "verbatim_here_string_characters") return { type: "string", values: [body] };
		if (body.includes("`")) return;
		pos = text.indexOf("\n") + 1; end = pos + body.length;
	} else if (node.type !== "expandable_string_literal" || !/^"(?:`"|[^"`\u2018-\u201e])*"$/su.test(text)) return;
	const parts: Part[] = [];
	for (const child of node.namedChildren) {
		const token = child.text.trimStart();
		const literal = text.slice(pos, child.endIndex - node.startIndex - token.length);
		if (literal.includes("$")) return;
		parts.push(literal.replaceAll('`"', '"'));
		if (child.type === "variable" || child.type === "braced_variable") parts.push({ token });
		else if (child.type === "sub_expression") {
			const statements = child.childForFieldName("statements"), expr = statements?.firstNamedChild;
			const value = expr && statements?.namedChildCount === 1 && evaluate(expr);
			if (!value || value.type !== "string" && value.values.includes(undefined)) return;
			parts.push({ value, id: child.id });
		} else return;
		pos = child.endIndex - node.startIndex;
	}
	const suffix = text.slice(pos, end);
	if (!suffix.includes("$")) return interpolate([...parts, suffix.replaceAll('`"', '"')], flow, env);
}
