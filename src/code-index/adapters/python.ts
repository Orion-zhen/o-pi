import { collectUnits, nameField, rawImport, rawUnit, walkNamed, type UnitRules } from "./shared.js";
import type { AnalysisControl } from "../types.js";
import { TREE_SITTER_GRAMMARS } from "../../syntax-tree/grammars.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const PYTHON_UNIT_KINDS = new Set(["function_definition", "class_definition"]);

const pythonRules: UnitRules = {
	extract(node, scope) {
		if (!PYTHON_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node);
		return name === undefined ? undefined : rawUnit(node, node.type === "class_definition" ? "class" : "function", name, scope, isPublicName(name));
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" ? unit.qualifiedName ?? unit.name ?? current : current;
	},
	shouldDescend(_node, unit) {
		return unit.kind === "class";
	},
};

function isPublicName(name: string): boolean {
	return !name.startsWith("_");
}

function extractPythonImports(root: SyntaxNode, control: AnalysisControl): RawImport[] {
	const imports: RawImport[] = [];
	walkNamed(root, (node) => {
		if (node.type === "import_from_statement") {
			const module = node.childForFieldName("module_name");
			if (module === null) return;
			if (module.type === "relative_import" && module.namedChildren.every((child) => child.type === "import_prefix")) {
				for (const imported of node.childrenForFieldName("name")) {
					const target = imported.type === "aliased_import" ? imported.childForFieldName("name") : imported;
					if (target !== null) imports.push({ specifier: `${module.text}${target.text}`, startChar: module.startIndex, endChar: target.endIndex, importKind: "relative" });
				}
				return;
			}
			imports.push(rawImport(node, module, module.type === "relative_import" ? "relative" : undefined));
			return;
		}
		if (node.type !== "import_statement") return;
		for (const child of node.namedChildren) {
			const target = child.type === "aliased_import" ? child.childForFieldName("name") : child;
			if (target !== null && target !== undefined && (target.type === "dotted_name" || target.type === "identifier")) {
				imports.push(rawImport(node, target));
			}
		}
	}, control);
	return imports;
}

export const pythonAdapter: LanguageAdapter = {
	language: "python",
	extensions: [".py"],
	grammar: TREE_SITTER_GRAMMARS.python,
	extractUnits: (root, control) => collectUnits(root, pythonRules, control),
	extractImports: extractPythonImports,
};
