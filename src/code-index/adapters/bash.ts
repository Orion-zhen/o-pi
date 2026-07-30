import { collectUnits, nameField, rawImport, rawUnit, walkNamed, type UnitRules } from "./shared.js";
import type { AnalysisControl } from "../types.js";
import { getTreeSitterLanguage } from "../../syntax-tree/grammars.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

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

function extractBashImports(root: SyntaxNode, control: AnalysisControl): RawImport[] {
	const imports: RawImport[] = [];
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

function staticShellImport(node: SyntaxNode): RawImport | undefined {
	if (node.type === "word" && node.namedChildren.length === 0) return rawImport(node, node, "relative");
	if (node.type === "raw_string" && node.text.length >= 2) {
		return {
			specifier: node.text.slice(1, -1),
			startChar: node.startIndex + 1,
			endChar: node.endIndex - 1,
			importKind: "relative",
		};
	}
	if (node.type !== "string" || node.namedChildren.length !== 1) return undefined;
	const content = node.namedChildren[0];
	return content?.type === "string_content" ? rawImport(node, content, "relative") : undefined;
}

export const bashAdapter: LanguageAdapter = {
	...getTreeSitterLanguage("bash"),
	extractUnits: (root, control) => collectUnits(root, bashRules, control),
	extractImports: extractBashImports,
};
