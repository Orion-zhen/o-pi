import { collectUnits, nameField, rawUnit, walkNamed, type UnitRules } from "./shared.js";
import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.js";
import type { ModuleImport } from "../types.js";
import type { LanguageExtractor } from "./types.js";

const bashRules: UnitRules = {
	extract(node) {
		if (node.type !== "function_definition") return undefined;
		const name = nameField(node);
		return name === undefined ? undefined : rawUnit(node, "function", name, undefined, !name.startsWith("_"));
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend() {
		return false;
	},
};

function extractBashImports(root: SyntaxNode, control: AnalysisControl): ModuleImport[] {
	const imports: ModuleImport[] = [];
	walkNamed(root, (node) => {
		if (node.type !== "command") return;
		const commandName = node.childForFieldName("name");
		if (commandName === null || (commandName.text !== "source" && commandName.text !== ".")) return;
		const target = node.namedChildren.find((child) =>
			child.id !== commandName.id
			&& child.type !== "file_redirect"
			&& child.type !== "herestring_redirect"
			&& child.type !== "variable_assignment");
		const imported = target === undefined ? undefined : staticShellImport(target);
		if (imported !== undefined) imports.push(imported);
	}, control);
	return imports;
}

function staticShellImport(node: SyntaxNode): ModuleImport | undefined {
	if (node.type === "word" && node.namedChildren.length === 0) return { specifier: node.text, importKind: "relative" };
	if (node.type === "raw_string" && node.text.length >= 2) {
		return {
			specifier: node.text.slice(1, -1),
			importKind: "relative",
		};
	}
	if (node.type !== "string" || node.namedChildren.length !== 1) return undefined;
	const content = node.namedChildren[0];
	return content?.type === "string_content" ? { specifier: content.text, importKind: "relative" } : undefined;
}

export const bashExtractor: LanguageExtractor = {
	extractUnits: (root, control) => collectUnits(root, bashRules, control),
	extractImports: extractBashImports,
};
