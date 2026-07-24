import {
	collectCIncludeImports,
	collectUnits,
	declaratorName,
	firstNamedChildText,
	functionDeclaratorName,
	hasSimpleFunctionDeclarator,
	rawUnit,
	type UnitRules,
} from "./shared.js";
import type { LanguageAdapter } from "./types.js";

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

export const cAdapter: LanguageAdapter = {
	language: "c",
	extensions: [".c"],
	grammar: { packageName: "tree-sitter-c" },
	extractUnits: (root) => collectUnits(root, cRules),
	collectImports: collectCIncludeImports,
};
