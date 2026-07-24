import { collectRegexImports, collectUnits, firstNamedChildText, nameField, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter } from "./types.js";

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
const IMPORT_PATTERNS = [
	/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu,
	/\b(?:require|import)\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu,
];

const tsRules: UnitRules = {
	extract(node, scope) {
		if (!TS_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "property_identifier", "type_identifier"]);
		return name === undefined ? undefined : rawUnit(node, normalizeTsKind(node.type), name, scope);
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" ? unit.name ?? current : current;
	},
	shouldDescend(_node, unit) {
		return unit.kind === "class" || unit.kind === "interface";
	},
};

function normalizeTsKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_definition") return "method";
	if (kind === "class_declaration") return "class";
	if (kind === "interface_declaration") return "interface";
	if (kind === "type_alias_declaration") return "type";
	if (kind === "enum_declaration") return "enum";
	if (kind === "variable_declarator") return "declaration";
	return "declaration";
}

function extractJavaScriptUnits(root: Parameters<LanguageAdapter["extractUnits"]>[0]) {
	return collectUnits(root, tsRules);
}

function collectJavaScriptImports(text: string, index: Parameters<LanguageAdapter["collectImports"]>[1]) {
	return collectRegexImports(text, index, IMPORT_PATTERNS);
}

export const javascriptAdapter: LanguageAdapter = {
	language: "javascript",
	extensions: [".js", ".mjs", ".cjs"],
	grammar: { packageName: "tree-sitter-javascript" },
	extractUnits: extractJavaScriptUnits,
	collectImports: collectJavaScriptImports,
};

export const jsxAdapter: LanguageAdapter = {
	language: "jsx",
	extensions: [".jsx"],
	grammar: { packageName: "tree-sitter-javascript" },
	extractUnits: extractJavaScriptUnits,
	collectImports: collectJavaScriptImports,
};
