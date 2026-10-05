import { collectUnits, functionUnit, rawUnit, type UnitRules } from "./shared.ts";
import type { SyntaxNode } from "../../syntax-tree/types.ts";
import type { LanguageExtractor } from "./types.ts";

const pythonRules: UnitRules = {
	extract(node, scope, text) {
		if (node.type === "lambda") {
			const parent = node.parent;
			const name = parent?.type === "assignment" && parent.childForFieldName("right")?.id === node.id ? parent.childForFieldName("left") : undefined;
			const binding = name?.type === "identifier" && parent !== null ? { name, declaration: parent } : undefined;
			const call = parent?.type === "argument_list" ? parent.parent : undefined;
			return functionUnit(node, scope, text, node.childForFieldName("body"), binding, call);
		}
		if (node.type !== "function_definition" && node.type !== "class_definition") return undefined;
		const name = node.childForFieldName("name");
		if (name === null) return undefined;
		return rawUnit(node, node.type === "class_definition" ? "class" : "function", name.text, scope, {
			name, body: node.childForFieldName("body"),
			range: node.parent?.type === "decorated_definition" ? node.parent : node,
			...(node.type === "function_definition" ? { callable: node } : {}),
		});
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" ? unit.qualifiedName : current;
	},
	isContainer(_node, unit) {
		return unit.kind === "class";
	},
};

function calleeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type === "identifier") return node;
	const child = node.type === "attribute" ? node.childForFieldName("attribute")
		: node.type === "parenthesized_expression" ? node.namedChildren[0] : undefined;
	return child == null ? undefined : calleeIdentifier(child);
}

export const pythonExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, pythonRules, control),
	call(node) {
		const callee = node.type === "call" ? node.childForFieldName("function") : undefined;
		if (callee == null) return undefined;
		const lookup = calleeIdentifier(callee);
		return { callee, ...(lookup === undefined ? {} : { lookup }) };
	},
};
