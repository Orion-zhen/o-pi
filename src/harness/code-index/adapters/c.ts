import { collectUnits, firstNamedChildText, rawUnit, type UnitRules } from "./shared.js";
import { declaratorName, functionDeclaratorName, hasSimpleFunctionDeclarator, hasStorageClass, extractIncludes } from "./c-family.js";
import type { LanguageExtractor } from "./types.js";

const cRules: UnitRules = {
	extract(node) {
		switch (node.type) {
			case "function_definition": {
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : rawUnit(node, "function", name, undefined, !hasStorageClass(node, "static"));
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
				const functionDeclaration = hasSimpleFunctionDeclarator(node);
				return rawUnit(node, functionDeclaration ? "function" : "declaration", name, undefined, functionDeclaration && !hasStorageClass(node, "static"));
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

export const cExtractor: LanguageExtractor = {
	extractUnits: (root, control) => collectUnits(root, cRules, control),
	extractImports: extractIncludes,
};
