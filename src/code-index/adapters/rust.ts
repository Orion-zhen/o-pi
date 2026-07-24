import { collectUnits, firstNamedChildText, nameField, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const RUST_UNIT_KINDS = new Set([
	"function_item",
	"function_signature_item",
	"struct_item",
	"enum_item",
	"type_item",
	"trait_item",
	"impl_item",
	"const_item",
	"static_item",
	"mod_item",
]);

const rustRules: UnitRules = {
	extract(node, scope) {
		if (!RUST_UNIT_KINDS.has(node.type)) return undefined;
		if (node.type === "impl_item") {
			const target = node.childForFieldName("type")?.text ?? node.childForFieldName("trait")?.text;
			return rawUnit(node, "module", target ?? "impl", scope);
		}
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const unitScope = node.type === "function_item" || node.type === "function_signature_item" || node.type === "mod_item" ? scope : undefined;
		return rawUnit(node, normalizeRustKind(node.type), name, unitScope, hasVisibility(node));
	},
	childScope(node, unit, current) {
		return node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item"
			? unit?.qualifiedName ?? unit?.name ?? current
			: current;
	},
	shouldDescend(node) {
		return node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item";
	},
};

function hasVisibility(node: SyntaxNode): boolean {
	return node.namedChildren.some((child) => child.type === "visibility_modifier");
}

function normalizeRustKind(kind: string): string {
	if (kind === "function_item" || kind === "function_signature_item") return "function";
	if (kind === "struct_item" || kind === "enum_item" || kind === "type_item") return "type";
	if (kind === "trait_item") return "trait";
	if (kind === "impl_item" || kind === "mod_item") return "module";
	return "declaration";
}

function extractRustImports(root: SyntaxNode): RawImport[] {
	const imports: RawImport[] = [];
	walk(root, (node) => {
		if (node.type === "use_declaration") collectUse(node.childForFieldName("argument"), "", imports);
	});
	return imports;
}

function collectUse(node: SyntaxNode | null, prefix: string, imports: RawImport[]): void {
	if (node === null) return;
	switch (node.type) {
		case "scoped_use_list": {
			const path = node.childForFieldName("path");
			const list = node.childForFieldName("list");
			if (path === null || list === null) return;
			collectUse(list, qualify(prefix, path.text), imports);
			return;
		}
		case "use_list":
			for (const child of node.namedChildren) collectUse(child, prefix, imports);
			return;
		case "use_as_clause": {
			const path = node.childForFieldName("path");
			if (path !== null) addRustImport(qualify(prefix, path.text), path, imports);
			return;
		}
		case "use_wildcard": {
			const path = node.namedChildren[0];
			const base = path === undefined ? prefix : qualify(prefix, path.text);
			if (base.length > 0) addRustImport(`${base}::*`, node, imports);
			return;
		}
		default:
			if (node.type === "identifier" || node.type === "scoped_identifier" || node.type === "crate" || node.type === "self") {
				addRustImport(qualify(prefix, node.text), node, imports);
			}
	}
}

function addRustImport(specifier: string, node: SyntaxNode, imports: RawImport[]): void {
	imports.push({ specifier, startChar: node.startIndex, endChar: node.endIndex });
}

function qualify(prefix: string, value: string): string {
	return prefix.length === 0 ? value : `${prefix}::${value}`;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

export const rustAdapter: LanguageAdapter = {
	language: "rust",
	extensions: [".rs"],
	grammar: { packageName: "tree-sitter-rust" },
	extractUnits: (root) => collectUnits(root, rustRules),
	extractImports: extractRustImports,
};
