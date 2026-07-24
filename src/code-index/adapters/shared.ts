import type { IndexedImport, LineIndex } from "../types.js";
import type { RawImport, RawUnit, SyntaxNode } from "./types.js";

export interface UnitRules {
	extract(node: SyntaxNode, scope: string | undefined): RawUnit | undefined;
	childScope(node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined;
	shouldDescend(node: SyntaxNode, unit: RawUnit): boolean;
}

export function collectUnits(root: SyntaxNode, rules: UnitRules): RawUnit[] {
	const units: RawUnit[] = [];
	walkUnits(root, undefined, rules, units);
	return units.sort(compareRawUnits);
}

function walkUnits(node: SyntaxNode, scope: string | undefined, rules: UnitRules, units: RawUnit[]): void {
	const unit = rules.extract(node, scope);
	if (unit !== undefined) units.push(unit);
	if (unit !== undefined && !rules.shouldDescend(node, unit)) return;
	const childScope = rules.childScope(node, unit, scope);
	for (const child of node.namedChildren) walkUnits(child, childScope, rules, units);
}

export function rawUnit(node: SyntaxNode, kind: string, name: string, scope?: string, exported = false): RawUnit {
	const range = exportRangeNode(node);
	return {
		kind,
		name,
		qualifiedName: scope === undefined ? name : `${scope}.${name}`,
		exported,
		startChar: range.startIndex,
		endChar: range.endIndex,
	};
}

export function rawImport(node: SyntaxNode, specifierNode: SyntaxNode = node): RawImport {
	return {
		specifier: specifierNode.text,
		startChar: specifierNode.startIndex,
		endChar: specifierNode.endIndex,
	};
}

export function exportRangeNode(node: SyntaxNode): SyntaxNode {
	const parent = node.parent;
	return parent?.type === "export_statement" ? parent : node;
}

export function nameField(node: SyntaxNode): string | undefined {
	return node.childForFieldName("name")?.text;
}

export function firstNamedChildText(node: SyntaxNode, types: readonly string[]): string | undefined {
	return node.namedChildren.find((child) => types.includes(child.type))?.text;
}

const DECLARATOR_NAME_TYPES = new Set([
	"identifier",
	"field_identifier",
	"type_identifier",
	"qualified_identifier",
	"scoped_identifier",
	"operator_name",
	"destructor_name",
]);

export function declaratorName(node: SyntaxNode): string | undefined {
	const declarator = node.childForFieldName("declarator");
	return declarator === null ? undefined : namedDeclarator(declarator);
}

export function functionDeclaratorName(node: SyntaxNode): string | undefined {
	const functionDeclarator = findFunctionDeclarator(node);
	return functionDeclarator === undefined ? undefined : namedDeclarator(functionDeclarator);
}

export function hasSimpleFunctionDeclarator(node: SyntaxNode): boolean {
	const functionDeclarator = findFunctionDeclarator(node);
	const declarator = functionDeclarator?.childForFieldName("declarator");
	return declarator !== null && declarator !== undefined && (DECLARATOR_NAME_TYPES.has(declarator.type) || declarator.type === "reference_declarator");
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type === "function_declarator") return node;
	const declarator = node.childForFieldName("declarator");
	return declarator === null ? undefined : findFunctionDeclarator(declarator);
}

function namedDeclarator(node: SyntaxNode): string | undefined {
	if (DECLARATOR_NAME_TYPES.has(node.type)) return node.text;
	const declarator = node.childForFieldName("declarator");
	return declarator === null ? undefined : namedDeclarator(declarator);
}

export function hasAncestorType(node: SyntaxNode): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type === "class_specifier" || parent.type === "struct_specifier") return true;
	}
	return false;
}

export function indexRawImports(index: LineIndex, rawImports: readonly RawImport[]): IndexedImport[] {
	const imports: IndexedImport[] = [];
	const seen = new Set<string>();
	for (const match of rawImports) {
		const startByte = index.byteForChar(match.startChar);
		const endByte = index.byteForChar(match.endChar);
		const key = `${match.specifier}\0${startByte}\0${endByte}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push({
			specifier: match.specifier,
			startLine: index.lineForByte(startByte),
			endLine: index.lineForByte(Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		});
	}
	return imports.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind);
}
