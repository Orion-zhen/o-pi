import { collectUnits, firstNamedChildText, functionUnit, nameField, rawUnit, type UnitRules } from "./shared.ts";
import type { SyntaxNode } from "../../syntax-tree/types.ts";
import type { LanguageExtractor } from "./types.ts";

const TS_UNIT_KINDS = new Set([
	"function_declaration", "method_definition", "method_signature", "class_declaration",
	"interface_declaration", "type_alias_declaration", "enum_declaration", "variable_declaration", "variable_declarator",
]);
const FUNCTION_EXPRESSIONS = new Set(["arrow_function", "function_expression", "generator_function"]);

const javascriptRules: UnitRules = {
	extract(node, scope, text) {
		if (FUNCTION_EXPRESSIONS.has(node.type)) {
			const name = node.childForFieldName("name");
			const call = node.parent?.type === "arguments" ? node.parent.parent : undefined;
			return functionUnit(node, scope, text, node.childForFieldName("body"), name === null ? undefined : { name, declaration: node }, call);
		}
		const property = node.type === "pair" || node.type === "public_field_definition" || node.type === "field_definition";
		if (!TS_UNIT_KINDS.has(node.type) && !property) return undefined;
		const value = node.childForFieldName("value");
		if (property && (value === null || !FUNCTION_EXPRESSIONS.has(value.type))) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "property_identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const kind = normalizeTsKind(node.type);
		const callable = value !== null && FUNCTION_EXPRESSIONS.has(value.type) ? value
			: kind === "function" || kind === "method" ? node : undefined;
		const declaredName = node.childForFieldName("name");
		const nameNode = declaredName?.text === name ? declaredName
			: node.namedChildren.find((child) => child.text === name && /identifier|name/u.test(child.type));
		return rawUnit(node, kind, name, scope, {
			range: node.parent?.type === "export_statement" ? node.parent : node,
			...(nameNode === undefined ? {} : { name: nameNode }),
			body: (callable ?? node).childForFieldName("body") ?? node.childForFieldName("type")?.childForFieldName("body"),
			...(callable === undefined ? {} : { callable }),
			...(callable === undefined || callable.id === node.id || nameField(callable) !== undefined ? {} : { ownedCallable: callable.id }),
		});
	},
	childScope(node, unit, current) {
		if (node.childForFieldName("value")?.type === "object") {
			const name = nameField(node) ?? node.childForFieldName("key")?.text;
			if (name !== undefined) return current === undefined ? name : `${current}.${name}`;
		}
		if (unit === undefined || (unit.kind !== "class" && unit.kind !== "interface")) return current;
		return unit.qualifiedName;
	},
	isContainer(_node, unit) {
		return unit.kind === "class" || unit.kind === "interface";
	},
};

function normalizeTsKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_definition" || kind === "method_signature") return "method";
	if (kind === "class_declaration") return "class";
	if (kind === "interface_declaration") return "interface";
	if (kind === "type_alias_declaration") return "type";
	if (kind === "enum_declaration") return "enum";
	return "declaration";
}

function calleeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.namedChildCount === 0 && node.type.includes("identifier")) return node;
	const child = node.type === "member_expression" ? node.childForFieldName("property")
		: node.type === "parenthesized_expression" ? node.namedChildren[0] : undefined;
	return child == null ? undefined : calleeIdentifier(child);
}

export const javascriptExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, javascriptRules, control),
	call(node) {
		const callee = node.type === "call_expression" ? node.childForFieldName("function")
			: node.type === "new_expression" ? node.childForFieldName("constructor") : undefined;
		if (callee == null) return undefined;
		const lookup = calleeIdentifier(callee);
		return { callee, ...(lookup === undefined ? {} : { lookup }) };
	},
};
