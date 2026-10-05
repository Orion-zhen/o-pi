import { collectUnits, firstNamedChildText, functionUnit, nameField, rawUnit, type UnitRules } from "./shared.ts";
import type { SyntaxNode } from "../../syntax-tree/types.ts";
import type { LanguageExtractor } from "./types.ts";

const GO_UNIT_KINDS = new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]);

const goRules: UnitRules = {
	extract(node, scope, text) {
		if (node.type === "func_literal") {
			return functionUnit(node, scope, text, node.childForFieldName("body"), functionBinding(node),
				node.parent?.type === "argument_list" ? node.parent.parent : undefined);
		}
		if (!GO_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "field_identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const receiver = node.type === "method_declaration" ? receiverType(node) : undefined;
		const kind = normalizeGoKind(node.type);
		const nameNode = node.childForFieldName("name");
		return rawUnit(node, kind, name, receiver ?? scope, {
			...(nameNode === null ? {} : { name: nameNode }),
			body: node.childForFieldName("body") ?? node.childForFieldName("type")?.childForFieldName("body"),
			...(kind === "function" || kind === "method" ? { callable: node } : {}),
		});
	},
	childScope(_node, _unit, current) { return current; },
	isContainer() { return false; },
};

function functionBinding(node: SyntaxNode): { name: SyntaxNode; declaration: SyntaxNode } | undefined {
	const list = node.parent;
	if (list?.type !== "expression_list" || list.namedChildCount !== 1) return undefined;
	const declaration = list.parent;
	let name: SyntaxNode | null | undefined;
	if (declaration?.type === "short_var_declaration" && declaration.childForFieldName("right")?.id === list.id) {
		const left = declaration.childForFieldName("left");
		if (left?.namedChildCount === 1) name = left.namedChildren[0];
	} else if (declaration?.type === "var_spec" && declaration.childForFieldName("value")?.id === list.id) {
		name = declaration.childForFieldName("name");
	}
	return name?.type === "identifier" && declaration !== null ? { name, declaration } : undefined;
}

function normalizeGoKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_declaration") return "method";
	if (kind === "type_spec") return "type";
	return "declaration";
}

function receiverType(node: SyntaxNode): string | undefined {
	const parameter = node.childForFieldName("receiver")?.namedChildren[0];
	if (parameter === undefined) return undefined;
	const stack = [parameter];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		if (current.type === "type_identifier") return current.text;
		stack.push(...[...current.namedChildren].reverse());
	}
	return undefined;
}

function calleeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.namedChildCount === 0 && node.type.includes("identifier")) return node;
	const child = node.type === "selector_expression" ? node.childForFieldName("field")
		: node.type === "parenthesized_expression" ? node.namedChildren[0] : undefined;
	return child == null ? undefined : calleeIdentifier(child);
}

export const goExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, goRules, control),
	call(node) {
		const callee = node.type === "call_expression" ? node.childForFieldName("function") : undefined;
		if (callee == null) return undefined;
		const lookup = calleeIdentifier(callee);
		return { callee, ...(lookup === undefined ? {} : { lookup }) };
	},
};
