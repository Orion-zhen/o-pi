import {
	collectUnits,
	declaratorName,
	firstNamedChildText,
	functionDeclaratorName,
	hasSimpleFunctionDeclarator,
	rawImport,
	rawUnit,
	type UnitRules,
} from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const cRules: UnitRules = {
	extract(node) {
		switch (node.type) {
			case "function_definition": {
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "function", name);
			}
			case "struct_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "struct", name);
			}
			case "enum_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "enum", name);
			}
			case "type_definition": {
				const name = declaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "typedef", name);
			}
			case "declaration": {
				const name = declaratorName(node) ?? firstNamedChildText(node, ["identifier", "field_identifier"]);
				if (name === undefined) return undefined;
				return rawUnit(node, hasSimpleFunctionDeclarator(node) ? "function" : "declaration", name);
			}
			default:
				return undefined;
		}
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend(node) {
		return node.type === "type_definition" || node.type === "declaration";
	},
};

function extractCImports(root: SyntaxNode): RawImport[] {
	const imports: RawImport[] = [];
	walk(root, (node) => {
		if (node.type !== "preproc_include") return;
		const path = node.childForFieldName("path");
		if (path === null) return;
		if (path.type === "system_lib_string") {
			imports.push({ specifier: path.text.slice(1, -1), startChar: path.startIndex + 1, endChar: path.endIndex - 1, importKind: "external" });
			return;
		}
		if (path.type === "string_literal") {
			const content = path.namedChildren[0];
			if (content !== undefined) imports.push(rawImport(path, content, "relative"));
		}
	});
	return imports;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}

export const cAdapter: LanguageAdapter = {
	language: "c",
	extensions: [".c"],
	grammar: { packageName: "tree-sitter-c" },
	extractUnits: (root) => collectUnits(root, cRules),
	extractImports: extractCImports,
};
