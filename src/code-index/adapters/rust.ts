import { collectRegexImports, collectUnits, firstNamedChildText, nameField, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter } from "./types.js";

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
const IMPORT_PATTERNS = [/\buse\s+(?<specifier>(?:::)?[A-Za-z_][\w:]*)/gu];

const rustRules: UnitRules = {
	extract(node, scope) {
		if (!RUST_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "type_identifier"]);
		if (node.type === "impl_item" && name === undefined) return rawUnit(node, "module", "impl");
		if (name === undefined) return undefined;
		const functionScope = node.type === "function_item" || node.type === "function_signature_item" ? scope : undefined;
		return rawUnit(node, normalizeRustKind(node.type), name, functionScope);
	},
	childScope(node, unit, current) {
		return node.type === "impl_item" || node.type === "trait_item" ? unit?.name ?? current : current;
	},
	shouldDescend(node) {
		return node.type === "impl_item" || node.type === "trait_item" || node.type === "mod_item";
	},
};

function normalizeRustKind(kind: string): string {
	if (kind === "function_item" || kind === "function_signature_item") return "function";
	if (kind === "struct_item" || kind === "enum_item" || kind === "type_item") return "type";
	if (kind === "trait_item") return "trait";
	if (kind === "impl_item" || kind === "mod_item") return "module";
	return "declaration";
}

export const rustAdapter: LanguageAdapter = {
	language: "rust",
	extensions: [".rs"],
	grammar: { packageName: "tree-sitter-rust" },
	extractUnits: (root) => collectUnits(root, rustRules),
	collectImports: (text, index) => collectRegexImports(text, index, IMPORT_PATTERNS),
};
