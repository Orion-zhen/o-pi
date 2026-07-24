import { collectUnits, firstNamedChildText, nameField, rawImport, rawUnit, type UnitRules } from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const GO_UNIT_KINDS = new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]);

const goRules: UnitRules = {
	extract(node) {
		if (!GO_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "field_identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const receiver = node.type === "method_declaration" ? receiverType(node) : undefined;
		return rawUnit(node, normalizeGoKind(node.type), name, receiver);
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend() {
		return false;
	},
};

function normalizeGoKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_declaration") return "method";
	if (kind === "type_spec") return "type";
	return "declaration";
}

function receiverType(node: SyntaxNode): string | undefined {
	const receiver = node.childForFieldName("receiver");
	if (receiver === null) return undefined;
	const parameter = receiver.namedChildren[0];
	if (parameter === undefined) return undefined;
	return findTypeIdentifier(parameter)?.text;
}

function findTypeIdentifier(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type === "type_identifier") return node;
	for (const child of node.namedChildren) {
		const found = findTypeIdentifier(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

function extractGoImports(root: SyntaxNode): RawImport[] {
	const imports: RawImport[] = [];
	walk(root, (node) => {
		if (node.type !== "import_declaration") return;
		for (const child of node.namedChildren) {
			if (child.type === "import_spec") {
				const imported = importSpec(child);
				if (imported !== undefined) imports.push(imported);
			} else if (child.type === "import_spec_list") {
				for (const spec of child.namedChildren) {
					const imported = importSpec(spec);
					if (imported !== undefined) imports.push(imported);
				}
			}
		}
	});
	return imports;
}

function importSpec(node: SyntaxNode): RawImport | undefined {
	const path = node.childForFieldName("path");
	if (path === null) return undefined;
	const content = path.namedChildren[0];
	return content === undefined ? undefined : rawImport(path, content);
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

export const goAdapter: LanguageAdapter = {
	language: "go",
	extensions: [".go"],
	grammar: { packageName: "tree-sitter-go" },
	extractUnits: (root) => collectUnits(root, goRules),
	extractImports: extractGoImports,
};
