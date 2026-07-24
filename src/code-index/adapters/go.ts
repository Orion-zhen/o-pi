import { collectGoImports, collectUnits, firstNamedChildText, nameField, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter } from "./types.js";

const GO_UNIT_KINDS = new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]);

const goRules: UnitRules = {
	extract(node) {
		if (!GO_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "field_identifier", "type_identifier"]);
		return name === undefined ? undefined : rawUnit(node, normalizeGoKind(node.type), name);
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend() {
		return false;
	},
};

function normalizeGoKind(kind: string): string {
	if (kind === "function_declaration" || kind === "method_declaration") return "function";
	if (kind === "type_spec") return "type";
	return "declaration";
}

export const goAdapter: LanguageAdapter = {
	language: "go",
	extensions: [".go"],
	grammar: { packageName: "tree-sitter-go" },
	extractUnits: (root) => collectUnits(root, goRules),
	collectImports: collectGoImports,
};
