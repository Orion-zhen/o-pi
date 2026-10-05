import { collectUnits, firstNamedChildText, type UnitRules } from "./shared.ts";
import { cCall, cUnit, declaratorName, functionDeclaratorName, hasSimpleFunctionDeclarator } from "./c-family.ts";
import type { LanguageExtractor } from "./types.ts";

const cRules: UnitRules = {
	extract(node, scope) {
		switch (node.type) {
			case "function_definition": {
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : cUnit(node, "function", name, scope);
			}
			case "struct_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : cUnit(node, "struct", name);
			}
			case "enum_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : cUnit(node, "enum", name);
			}
			case "type_definition": {
				const name = declaratorName(node);
				return name === undefined ? undefined : cUnit(node, "typedef", name);
			}
			case "declaration": {
				const name = declaratorName(node) ?? firstNamedChildText(node, ["identifier", "field_identifier"]);
				if (name === undefined) return undefined;
				const functionDeclaration = hasSimpleFunctionDeclarator(node);
				return cUnit(node, functionDeclaration ? "function" : "declaration", name);
			}
			default:
				return undefined;
		}
	},
	childScope(_node, _unit, current) {
		return current;
	},
	isContainer(node) {
		return node.type === "type_definition" || node.type === "declaration";
	},
};

export const cExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, cRules, control),
	call: cCall,
};
