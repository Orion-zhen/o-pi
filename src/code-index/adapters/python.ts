import { collectRegexImports, collectUnits, nameField, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter } from "./types.js";

const PYTHON_UNIT_KINDS = new Set(["function_definition", "class_definition"]);
const IMPORT_PATTERNS = [
	/^\s*from\s+(?<specifier>[.A-Za-z_][\w.]*)\s+import\b/gmu,
	/^\s*import\s+(?<specifier>[A-Za-z_][\w.]*)/gmu,
];

const pythonRules: UnitRules = {
	extract(node, scope) {
		if (!PYTHON_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node);
		return name === undefined ? undefined : rawUnit(node, node.type === "class_definition" ? "class" : "function", name, scope);
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" ? unit.name ?? current : current;
	},
	shouldDescend(_node, unit) {
		return unit.kind === "class";
	},
};

export const pythonAdapter: LanguageAdapter = {
	language: "python",
	extensions: [".py"],
	grammar: { packageName: "tree-sitter-python" },
	extractUnits: (root) => collectUnits(root, pythonRules),
	collectImports: (text, index) => collectRegexImports(text, index, IMPORT_PATTERNS),
};
