import {
	collectCIncludeImports,
	collectUnits,
	declaratorName,
	firstNamedChildText,
	functionDeclaratorName,
	hasAncestorType,
	hasSimpleFunctionDeclarator,
	rawUnit,
	type UnitRules,
} from "./shared.js";
import type { LanguageAdapter } from "./types.js";

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

export const cppAdapter: LanguageAdapter = {
	language: "cpp",
	extensions: [".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
	grammar: { packageName: "tree-sitter-cpp" },
	extractUnits: (root) => collectUnits(root, cppRules),
	collectImports: collectCIncludeImports,
};
