import { collectUnits, nameField, rawImport, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const PYTHON_UNIT_KINDS = new Set(["function_definition", "class_definition"]);

const pythonRules: UnitRules = {
	extract(node, scope) {
		if (!PYTHON_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node);
		return name === undefined ? undefined : rawUnit(node, node.type === "class_definition" ? "class" : "function", name, scope);
	},
	childScope(_node, unit, current) {
		return unit?.kind === "class" ? unit.qualifiedName ?? unit.name ?? current : current;
	},
	shouldDescend(_node, unit) {
		return unit.kind === "class";
	},
};

function extractPythonImports(root: SyntaxNode): RawImport[] {
	const imports: RawImport[] = [];
	walk(root, (node) => {
		if (node.type === "import_from_statement") {
			const module = node.childForFieldName("module_name");
			if (module !== null) imports.push(rawImport(node, module));
			return;
		}
		if (node.type !== "import_statement") return;
		for (const child of node.namedChildren) {
			const target = child.type === "aliased_import" ? child.childForFieldName("name") : child;
			if (target !== null && target !== undefined && (target.type === "dotted_name" || target.type === "identifier")) {
				imports.push(rawImport(node, target));
			}
		}
	});
	return imports;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

export const pythonAdapter: LanguageAdapter = {
	language: "python",
	extensions: [".py"],
	grammar: { packageName: "tree-sitter-python" },
	extractUnits: (root) => collectUnits(root, pythonRules),
	extractImports: extractPythonImports,
};
