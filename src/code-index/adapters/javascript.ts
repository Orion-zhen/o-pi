import { collectUnits, firstNamedChildText, nameField, rawImport, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const TS_UNIT_KINDS = new Set([
	"function_declaration",
	"method_definition",
	"method_signature",
	"class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"variable_declaration",
	"variable_declarator",
]);

const tsRules: UnitRules = {
	extract(node, scope) {
		if (!TS_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "property_identifier", "type_identifier"]);
		return name === undefined ? undefined : rawUnit(node, normalizeTsKind(node.type), name, scope);
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" || unit?.kind === "interface" ? unit.qualifiedName ?? unit.name ?? current : current;
	},
	shouldDescend(_node, unit) {
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
	if (kind === "variable_declarator") return "declaration";
	return "declaration";
}

function extractJavaScriptUnits(root: SyntaxNode) {
	return collectUnits(root, tsRules);
}

function extractJavaScriptImports(root: SyntaxNode): RawImport[] {
	const imports: RawImport[] = [];
	walk(root, (node) => {
		if (node.type === "import_statement" || node.type === "export_statement") {
			const source = node.childForFieldName("source");
			const imported = source === null ? undefined : stringImport(source);
			if (imported !== undefined) imports.push(imported);
			return;
		}
		if (node.type !== "call_expression") return;
		const functionNode = node.childForFieldName("function");
		if (functionNode === null || (functionNode.type !== "identifier" && functionNode.type !== "import")) return;
		const args = node.childForFieldName("arguments");
		if (args === null || args.namedChildren.length !== 1) return;
		const argument = args.namedChildren[0];
		if (argument === undefined) return;
		const imported = stringImport(argument);
		if (imported !== undefined) imports.push(imported);
	});
	return imports;
}

function stringImport(node: SyntaxNode): RawImport | undefined {
	if (node.type !== "string") return undefined;
	const fragment = node.namedChildren.find((child) => child.type === "string_fragment");
	return fragment === undefined ? undefined : rawImport(node, fragment);
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

export const javascriptAdapter: LanguageAdapter = {
	language: "javascript",
	extensions: [".js", ".mjs", ".cjs"],
	grammar: { packageName: "tree-sitter-javascript" },
	extractUnits: extractJavaScriptUnits,
	extractImports: extractJavaScriptImports,
};

export const jsxAdapter: LanguageAdapter = {
	language: "jsx",
	extensions: [".jsx"],
	grammar: { packageName: "tree-sitter-javascript" },
	extractUnits: extractJavaScriptUnits,
	extractImports: extractJavaScriptImports,
};
