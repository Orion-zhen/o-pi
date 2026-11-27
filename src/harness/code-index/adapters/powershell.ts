import { staticPowerShellWord } from "../../syntax-tree/powershell.ts";
import { collectUnits, rawUnit, type UnitRules } from "./shared.ts";
import type { LanguageExtractor } from "./types.ts";

const powerShellRules: UnitRules = {
	extract(node, scope) {
		if (node.type !== "function_statement") return undefined;
		const children = node.children;
		const name = children.find((child) => child.type === "function_name");
		if (!name?.text) return undefined;
		const body = children.find((child) => child.type === "script_block");
		// script_block 不含花括号和前导注释；空函数甚至没有该节点。
		const opening = children.find((child) => child.type === "{");
		return {
			...rawUnit(node, "function", name.text, scope, { name, body, callable: node }),
			...(opening && { declarationEndChar: opening.startIndex }),
		};
	},
	childScope(_node, _unit, current) { return current; },
	isContainer() { return false; },
};

export const powerShellExtractor: LanguageExtractor = {
	extractUnits: (root, text, control) => collectUnits(root, text, powerShellRules, control),
	call(node) {
		const callee = node.type === "command" ? node.childForFieldName("command_name") : null;
		return callee && staticPowerShellWord(callee) ? { callee, lookup: callee } : undefined;
	},
};
