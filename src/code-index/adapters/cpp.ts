import {
	collectUnits,
	declaratorName,
	firstNamedChildText,
	functionDeclaratorName,
	hasAncestorType,
	hasSimpleFunctionDeclarator,
	rawImport,
	rawUnit,
	type UnitRules,
} from "./shared.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const cppRules: UnitRules = {
	extract(node, scope) {
		switch (node.type) {
			case "function_definition": {
				const name = functionDeclaratorName(node);
				if (name === undefined) return undefined;
				return rawUnit(node, hasAncestorType(node) || name.includes("::") ? "method" : "function", name, scope);
			}
			case "field_declaration": {
				if (!hasSimpleFunctionDeclarator(node)) return undefined;
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "method", name, scope);
			}
			case "namespace_definition": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["namespace_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "namespace", name, scope);
			}
			case "class_specifier":
			case "struct_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, node.type === "class_specifier" ? "class" : "struct", name, scope);
			}
			case "enum_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "enum", name, scope);
			}
			case "alias_declaration": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : rawUnit(node, "alias", name, scope);
			}
			case "type_definition": {
				const name = declaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "typedef", name, scope);
			}
			case "declaration": {
				if (hasAncestorType(node)) {
					if (!hasSimpleFunctionDeclarator(node)) return undefined;
					const name = functionDeclaratorName(node);
					return name === undefined ? undefined : rawUnit(node, "method", name, scope);
				}
				const name = declaratorName(node) ?? firstNamedChildText(node, ["identifier", "field_identifier"]);
				if (name === undefined) return undefined;
				return rawUnit(node, hasSimpleFunctionDeclarator(node) ? "function" : "declaration", name, scope);
			}
			default:
				return undefined;
		}
	},
	childScope(node, unit, current) {
		if (node.type !== "namespace_definition" && node.type !== "class_specifier" && node.type !== "struct_specifier") return current;
		return unit?.qualifiedName ?? unit?.name ?? current;
	},
	shouldDescend(node) {
		return node.type === "namespace_definition" || node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "declaration" || node.type === "type_definition";
	},
};

function extractCppImports(root: SyntaxNode): RawImport[] {
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

export const cppAdapter: LanguageAdapter = {
	language: "cpp",
	extensions: [".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
	grammar: { packageName: "tree-sitter-cpp" },
	extractUnits: (root) => collectUnits(root, cppRules),
	extractImports: extractCppImports,
};
