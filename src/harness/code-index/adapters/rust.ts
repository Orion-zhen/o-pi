import { collectUnits, firstNamedChildText, functionUnit, nameField, rawUnit, type UnitRules } from "./shared.ts";
import type { SyntaxNode } from "../../syntax-tree/types.ts";
import type { LanguageExtractor, RawUnit } from "./types.ts";

const RUST_UNIT_KINDS = new Set([
	"function_item", "function_signature_item", "struct_item", "enum_item", "type_item",
	"trait_item", "impl_item", "const_item", "static_item", "mod_item",
]);

const rustRules: UnitRules = {
	extract(node, scope, text) {
		if (node.type === "closure_expression") {
			const parent = node.parent;
			const name = parent?.type === "let_declaration" && parent.childForFieldName("value")?.id === node.id ? parent.childForFieldName("pattern") : undefined;
			const binding = name?.type === "identifier" && parent !== null ? { name, declaration: parent } : undefined;
			return functionUnit(node, scope, text, node.childForFieldName("body"), binding,
				parent?.type === "arguments" ? parent.parent : undefined);
		}
		if (!RUST_UNIT_KINDS.has(node.type)) return undefined;
		if (node.type === "impl_item") {
			const target = node.childForFieldName("type")?.text ?? node.childForFieldName("trait")?.text;
			return rustUnit(node, "module", target ?? "impl", scope);
		}
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const unitScope = node.type === "function_item" || node.type === "function_signature_item" || node.type === "mod_item" ? scope : undefined;
		return rustUnit(node, normalizeRustKind(node.type), name, unitScope);
	},
	childScope(node, unit, current) {
		if (unit === undefined || (node.type !== "impl_item" && node.type !== "trait_item" && node.type !== "mod_item")) return current;
		return unit.qualifiedName;
	},
	isContainer(node) {
		return node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item";
	},
};

function rustUnit(node: SyntaxNode, kind: string, name: string, scope?: string): RawUnit {
	const nameNode = node.namedChildren.find((child) => child.text === name && /identifier|name/u.test(child.type));
	const value = node.childForFieldName("value");
	const callable = value?.type === "closure_expression" ? value : kind === "function" ? node : undefined;
	return rawUnit(node, kind, name, scope, {
		...(nameNode === undefined ? {} : { name: nameNode }),
		body: (callable ?? node).childForFieldName("body"),
		...(callable === undefined ? {} : { callable }),
		...(callable === undefined || callable.id === node.id ? {} : { ownedCallable: callable.id }),
	});
}

function normalizeRustKind(kind: string): string {
	if (kind === "function_item" || kind === "function_signature_item") return "function";
	if (kind === "struct_item" || kind === "enum_item" || kind === "type_item") return "type";
	if (kind === "trait_item") return "trait";
	if (kind === "impl_item" || kind === "mod_item") return "module";
	return "declaration";
}

function calleeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.namedChildCount === 0 && node.type.includes("identifier")) return node;
	const child = node.type === "field_expression" ? node.childForFieldName("field")
		: node.type === "scoped_identifier" ? node.childForFieldName("name")
		: node.type === "generic_function" ? node.childForFieldName("function")
		: node.type === "parenthesized_expression" ? node.namedChildren[0] : undefined;
	return child == null ? undefined : calleeIdentifier(child);
}

export const rustExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, rustRules, control),
	call(node) {
		const callee = node.type === "call_expression" ? node.childForFieldName("function") : undefined;
		if (callee == null) return undefined;
		const lookup = calleeIdentifier(callee);
		return { callee, ...(lookup === undefined ? {} : { lookup }) };
	},
};
