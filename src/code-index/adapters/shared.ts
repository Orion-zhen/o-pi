import type { ImportKind, IndexedImport, LineIndex } from "../types.js";
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
		sourceNode: node,
	};
}

export interface RawUnitRelations {
	references: string[];
	calls: string[];
}

/** Extract lexical facts from syntax nodes owned by this unit, excluding separately indexed child units. */
export function extractUnitRelations(unit: RawUnit, unitNodeIds: ReadonlySet<number>): RawUnitRelations {
	const references = new Set<string>();
	const calls = new Set<string>();
	walkRelations(unit.sourceNode, unit.sourceNode.id, unitNodeIds, references, calls);
	if (unit.name !== undefined) references.delete(unit.name);
	if (unit.qualifiedName !== undefined) references.delete(unit.qualifiedName);
	return { references: [...references], calls: [...calls] };
}

export function rawImport(node: SyntaxNode, specifierNode: SyntaxNode = node, importKind?: ImportKind): RawImport {
	return {
		specifier: specifierNode.text,
		startChar: specifierNode.startIndex,
		endChar: specifierNode.endIndex,
		...(importKind !== undefined ? { importKind } : {}),
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
		const key = `${match.specifier}\0${match.importKind ?? ""}\0${startByte}\0${endByte}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push({
			specifier: match.specifier,
			...(match.importKind !== undefined ? { importKind: match.importKind } : {}),
			startLine: index.lineForByte(startByte),
			endLine: index.lineForByte(Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		});
	}
	return imports.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
}

const CALL_NODE_TYPES = new Set(["call", "call_expression", "new_expression"]);
const STATIC_CALLEE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

function walkRelations(
	node: SyntaxNode,
	rootNodeId: number,
	unitNodeIds: ReadonlySet<number>,
	references: Set<string>,
	calls: Set<string>,
): void {
	if (node.id !== rootNodeId && unitNodeIds.has(node.id)) return;
	const callable = callableNode(node);
	if (callable !== undefined) {
		const target = staticCallee(callable);
		if (target === undefined) walkRelations(callable, rootNodeId, unitNodeIds, references, calls);
		else calls.add(target);
		for (const child of node.namedChildren) {
			if (child.id !== callable.id) walkRelations(child, rootNodeId, unitNodeIds, references, calls);
		}
		return;
	}
	if (isIdentifierLeaf(node)) references.add(node.text);
	for (const child of node.namedChildren) walkRelations(child, rootNodeId, unitNodeIds, references, calls);
}

function callableNode(node: SyntaxNode): SyntaxNode | undefined {
	if (!CALL_NODE_TYPES.has(node.type)) return undefined;
	return node.childForFieldName("function")
		?? node.childForFieldName("constructor")
		?? node.childForFieldName("type")
		?? undefined;
}

function staticCallee(node: SyntaxNode): string | undefined {
	if (isIdentifierLeaf(node)) return node.text;
	const normalized = node.text
		.replace(/\s+/gu, "")
		.replaceAll("?.", ".")
		.replaceAll("->", ".")
		.replaceAll("::", ".");
	return STATIC_CALLEE.test(normalized) ? normalized : undefined;
}

function isIdentifierLeaf(node: SyntaxNode): boolean {
	return node.namedChildren.length === 0 && (node.type === "identifier" || node.type.endsWith("_identifier"));
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind);
}
