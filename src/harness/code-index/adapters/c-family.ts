import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.js";
import type { ModuleImport } from "../types.js";
import { walkNamed } from "./shared.js";

const DECLARATOR_NAME_TYPES = new Set([
	"identifier", "field_identifier", "type_identifier", "qualified_identifier", "scoped_identifier", "operator_name", "destructor_name",
]);

export function declaratorName(node: SyntaxNode): string | undefined {
	const declarator = node.childForFieldName("declarator");
	return declarator === null ? undefined : namedDeclarator(declarator);
}

export function functionDeclaratorName(node: SyntaxNode): string | undefined {
	const declarator = findFunctionDeclarator(node);
	return declarator === undefined ? undefined : namedDeclarator(declarator);
}

export function hasSimpleFunctionDeclarator(node: SyntaxNode): boolean {
	const declarator = findFunctionDeclarator(node)?.childForFieldName("declarator");
	return declarator != null && (DECLARATOR_NAME_TYPES.has(declarator.type) || declarator.type === "reference_declarator");
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | undefined {
	for (let current: SyntaxNode | null = node; current !== null; current = current.childForFieldName("declarator")) {
		if (current.type === "function_declarator") return current;
	}
	return undefined;
}

function namedDeclarator(node: SyntaxNode): string | undefined {
	for (let current: SyntaxNode | null = node; current !== null; current = current.childForFieldName("declarator")) {
		if (DECLARATOR_NAME_TYPES.has(current.type)) return current.text;
	}
	return undefined;
}

export function hasAncestorType(node: SyntaxNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type === "class_specifier" || parent.type === "struct_specifier") return true;
	}
	return false;
}

export function hasStorageClass(node: SyntaxNode, storageClass: string): boolean {
	return node.namedChildren.some((child) => child.type === "storage_class_specifier" && child.text === storageClass);
}

export function extractIncludes(root: SyntaxNode, control: AnalysisControl): ModuleImport[] {
	const imports: ModuleImport[] = [];
	walkNamed(root, (node) => {
		if (node.type !== "preproc_include") return;
		const path = node.childForFieldName("path");
		if (path?.type === "system_lib_string") {
			imports.push({ specifier: path.text.slice(1, -1), importKind: "external" });
		} else if (path?.type === "string_literal") {
			const content = path.namedChildren[0];
			if (content !== undefined) imports.push({ specifier: content.text, importKind: "relative" });
		}
	}, control);
	return imports;
}
