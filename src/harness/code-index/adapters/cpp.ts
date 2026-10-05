import { collectUnits, firstNamedChildText, functionUnit, type UnitRules } from "./shared.ts";
import { cCall, cUnit, declaratorName, functionDeclaratorName, hasAncestorType, hasSimpleFunctionDeclarator } from "./c-family.ts";
import type { LanguageExtractor } from "./types.ts";

const cppRules: UnitRules = {
	extract(node, scope, text) {
		switch (node.type) {
			case "lambda_expression": {
				const parent = node.parent;
				const name = parent?.type === "init_declarator" && parent.childForFieldName("value")?.id === node.id ? parent.childForFieldName("declarator") : undefined;
				const binding = name?.type === "identifier" && parent !== null ? { name, declaration: parent } : undefined;
				return functionUnit(node, scope, text, node.childForFieldName("body"), binding,
					parent?.type === "argument_list" ? parent.parent : undefined);
			}
			case "function_definition": {
				const name = functionDeclaratorName(node);
				if (name === undefined) return undefined;
				const method = hasAncestorType(node) || name.includes("::");
				return cUnit(node, method ? "method" : "function", name, scope);
			}
			case "field_declaration": {
				if (!hasSimpleFunctionDeclarator(node)) return undefined;
				const name = functionDeclaratorName(node);
				return name === undefined ? undefined : cUnit(node, "method", name, scope);
			}
			case "namespace_definition": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["namespace_identifier"]);
				return name === undefined ? undefined : cUnit(node, "namespace", name, scope);
			}
			case "class_specifier":
			case "struct_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : cUnit(node, node.type === "class_specifier" ? "class" : "struct", name, scope);
			}
			case "enum_specifier": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : cUnit(node, "enum", name, scope);
			}
			case "alias_declaration": {
				const name = node.childForFieldName("name")?.text ?? firstNamedChildText(node, ["type_identifier"]);
				return name === undefined ? undefined : cUnit(node, "alias", name, scope);
			}
			case "type_definition": {
				const name = declaratorName(node);
				return name === undefined ? undefined : cUnit(node, "typedef", name, scope);
			}
			case "declaration": {
				if (hasAncestorType(node)) {
					if (!hasSimpleFunctionDeclarator(node)) return undefined;
					const name = functionDeclaratorName(node);
					return name === undefined ? undefined : cUnit(node, "method", name, scope);
				}
				const name = declaratorName(node) ?? firstNamedChildText(node, ["identifier", "field_identifier"]);
				if (name === undefined) return undefined;
				const functionDeclaration = hasSimpleFunctionDeclarator(node);
				return cUnit(node, functionDeclaration ? "function" : "declaration", name, scope);
			}
			default:
				return undefined;
		}
	},
	childScope(node, unit, current) {
		if (node.type !== "namespace_definition" && node.type !== "class_specifier" && node.type !== "struct_specifier") return current;
		return unit === undefined ? current : unit.qualifiedName;
	},
	isContainer(node) {
		return node.type === "namespace_definition" || node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "declaration" || node.type === "type_definition";
	},
};

export const cppExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, cppRules, control),
	call: cCall,
};
