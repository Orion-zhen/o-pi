import type { SyntaxNode } from "../../syntax-tree/types.ts";
import { rawUnit } from "./shared.ts";
import type { RawCall, RawUnit } from "./types.ts";

export function cUnit(node: SyntaxNode, kind: string, name: string, scope?: string): RawUnit {
	const nameNode = declarationNameNode(node, name);
	return rawUnit(node, kind, name, scope, {
		...(nameNode === undefined ? {} : { name: nameNode }),
		body: node.childForFieldName("body") ?? node.childForFieldName("type")?.childForFieldName("body"),
		...(kind === "function" || kind === "method" ? { callable: node } : {}),
	});
}

function declarationNameNode(node: SyntaxNode, name: string): SyntaxNode | undefined {
	const named = node.childForFieldName("name");
	if (named !== null && named.text === name) return named;
	for (let current = node.childForFieldName("declarator"); current !== null; current = current.childForFieldName("declarator")) {
		if (current.text === name) return current;
	}
	return node.namedChildren.find((child) => child.text === name && /identifier|name/u.test(child.type));
}

export function cCall(node: SyntaxNode): RawCall | undefined {
	const callee = node.type === "call_expression" ? node.childForFieldName("function")
		: node.type === "new_expression" ? node.childForFieldName("type") : undefined;
	if (callee == null) return undefined;
	const lookup = calleeIdentifier(callee);
	return { callee, ...(lookup === undefined ? {} : { lookup }) };
}

function calleeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.namedChildCount === 0 && node.type.includes("identifier")) return node;
	const child = node.type === "field_expression" ? node.childForFieldName("field")
		: node.type === "qualified_identifier" || node.type === "scoped_identifier" ? node.childForFieldName("name")
		: node.type === "template_function" ? node.childForFieldName("name")
		: node.type === "parenthesized_expression" ? node.namedChildren[0] : undefined;
	return child == null ? undefined : calleeIdentifier(child);
}

const DECLARATOR_NAME_TYPES = new Set([
	"identifier", "field_identifier", "type_identifier", "qualified_identifier", "scoped_identifier", "operator_name", "destructor_name",
]);

export function declaratorName(node: SyntaxNode): string | undefined {
	const declarator = node.childForFieldName("declarator");
	return declarator === null ? undefined : namedDeclarator(declarator);
}

export function functionDeclaratorName(node: SyntaxNode): string | undefined {
	const declarator = findFunctionDeclarator(node);
	return declarator === undefined ? undefined : namedDeclarator(declarator);
}

export function hasSimpleFunctionDeclarator(node: SyntaxNode): boolean {
	const declarator = findFunctionDeclarator(node)?.childForFieldName("declarator");
	return declarator != null && (DECLARATOR_NAME_TYPES.has(declarator.type) || declarator.type === "reference_declarator");
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | undefined {
	for (let current: SyntaxNode | null = node; current !== null; current = current.childForFieldName("declarator")) {
		if (current.type === "function_declarator") return current;
	}
	return undefined;
}

function namedDeclarator(node: SyntaxNode): string | undefined {
	for (let current: SyntaxNode | null = node; current !== null; current = current.childForFieldName("declarator")) {
		if (DECLARATOR_NAME_TYPES.has(current.type)) return current.text;
	}
	return undefined;
}

export function hasAncestorType(node: SyntaxNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type === "class_specifier" || parent.type === "struct_specifier") return true;
	}
	return false;
}
