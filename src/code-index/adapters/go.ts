import { collectUnits, firstNamedChildText, nameField, rawImport, rawUnit, walkNamed, type UnitRules } from "./shared.js";
import type { AnalysisControl } from "../types.js";
import { getTreeSitterLanguage } from "../../syntax-tree/grammars.js";
import type { LanguageAdapter, RawImport, SyntaxNode } from "./types.js";

const GO_UNIT_KINDS = new Set(["function_declaration", "method_declaration", "type_spec", "var_spec", "const_spec"]);

const goRules: UnitRules = {
	extract(node) {
		if (!GO_UNIT_KINDS.has(node.type)) return undefined;
		const name = nameField(node) ?? firstNamedChildText(node, ["identifier", "field_identifier", "type_identifier"]);
		if (name === undefined) return undefined;
		const receiver = node.type === "method_declaration" ? receiverType(node) : undefined;
		return rawUnit(node, normalizeGoKind(node.type), name, receiver, isPublicName(name));
	},
	childScope(_node, _unit, current) {
		return current;
	},
	shouldDescend() {
		return false;
	},
};

function isPublicName(name: string): boolean {
	return /^\p{Lu}/u.test(name);
}

function normalizeGoKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_declaration") return "method";
	if (kind === "type_spec") return "type";
	return "declaration";
}

function receiverType(node: SyntaxNode): string | undefined {
	const receiver = node.childForFieldName("receiver");
	if (receiver === null) return undefined;
	const parameter = receiver.namedChildren[0];
	if (parameter === undefined) return undefined;
	return findTypeIdentifier(parameter)?.text;
}

function findTypeIdentifier(root: SyntaxNode): SyntaxNode | undefined {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if (node.type === "type_identifier") return node;
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push(child);
		}
	}
	return undefined;
}

function extractGoImports(root: SyntaxNode, control: AnalysisControl): RawImport[] {
	const imports: RawImport[] = [];
	walkNamed(root, (node) => {
		if (node.type !== "import_declaration") return;
		for (const child of node.namedChildren) {
			if (child.type === "import_spec") {
				const imported = importSpec(child);
				if (imported !== undefined) imports.push(imported);
			} else if (child.type === "import_spec_list") {
				for (const spec of child.namedChildren) {
					const imported = importSpec(spec);
					if (imported !== undefined) imports.push(imported);
				}
			}
		}
	}, control);
	return imports;
}

function importSpec(node: SyntaxNode): RawImport | undefined {
	const path = node.childForFieldName("path");
	if (path === null) return undefined;
	const content = path.namedChildren[0];
	return content === undefined ? undefined : rawImport(path, content);
}

export const goAdapter: LanguageAdapter = {
	...getTreeSitterLanguage("go"),
	extractUnits: (root, control) => collectUnits(root, goRules, control),
	extractImports: extractGoImports,
};
