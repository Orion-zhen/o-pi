import { collectUnits, rawUnit, type UnitRules } from "./shared.ts";
import type { LanguageExtractor } from "./types.ts";

const bashRules: UnitRules = {
	extract(node, scope) {
		if (node.type !== "function_definition") return undefined;
		const name = node.childForFieldName("name");
		return name === null ? undefined : rawUnit(node, "function", name.text, scope, {
			name, body: node.childForFieldName("body"), callable: node,
		});
	},
	childScope(_node, _unit, current) { return current; },
	isContainer() { return false; },
};

export const bashExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, bashRules, control),
	call(node) {
		const callee = node.type === "command" ? node.childForFieldName("name") : undefined;
		if (callee == null) return undefined;
		const word = callee.type === "command_name" ? callee.namedChildren[0] : callee;
		return { callee, ...(word?.type === "word" ? { lookup: word } : {}) };
	},
};
