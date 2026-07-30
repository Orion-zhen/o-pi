import type { AnalysisControl, ImportKind, IndexedImport, LineIndex } from "../types.js";
import type { RawImport, RawUnit, SyntaxNode } from "./types.js";

export interface UnitRules {
	extract(node: SyntaxNode, scope: string | undefined): RawUnit | undefined;
	childScope(node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined;
	shouldDescend(node: SyntaxNode, unit: RawUnit): boolean;
}

export function collectUnits(root: SyntaxNode, rules: UnitRules, control: AnalysisControl): RawUnit[] {
	const units: RawUnit[] = [];
	const stack: Array<{ node: SyntaxNode; scope?: string }> = [{ node: root }];
	while (stack.length > 0) {
		control.check();
		const current = stack.pop();
		if (current === undefined) break;
		const { node, scope } = current;
		const unit = rules.extract(node, scope);
		if (unit !== undefined) units.push(unit);
		if (unit !== undefined && !rules.shouldDescend(node, unit)) continue;
		const childScope = rules.childScope(node, unit, scope);
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push({ node: child, ...(childScope !== undefined ? { scope: childScope } : {}) });
		}
	}
	return units.sort(compareRawUnits);
}

export function rawUnit(node: SyntaxNode, kind: string, name: string, scope?: string, exported = false): RawUnit {
	const range = exportRangeNode(node);
	const declarationEndChar = declarationBoundary(node);
	return {
		kind,
		name,
		qualifiedName: scope === undefined ? name : `${scope}.${name}`,
		exported,
		startChar: range.startIndex,
		endChar: range.endIndex,
		...(declarationEndChar === undefined ? {} : { declarationEndChar }),
		sourceNode: node,
	};
}

const DECLARATION_BODY_NODE_TYPES = new Set([
	"class_body",
	"declaration_list",
	"enum_variant_list",
	"field_declaration_list",
	"interface_body",
]);

function declarationBoundary(root: SyntaxNode): number | null | undefined {
	const directBody = root.childForFieldName("body");
	if (directBody !== null) {
		// 默认参数中的 lambda/closure 也有 body，无法用单一范围安全移除时省略 declaration。
		return nestedBodyStart(root, directBody.id) === undefined ? directBody.startIndex : null;
	}
	return nestedBodyStart(root);
}

function nestedBodyStart(root: SyntaxNode, excludedNodeId?: number): number | undefined {
	let earliest: number | undefined;
	const stack = [...root.namedChildren];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if (node.id === excludedNodeId) continue;
		const body = node.childForFieldName("body");
		if (body !== null) earliest = Math.min(earliest ?? Number.POSITIVE_INFINITY, body.startIndex);
		if (DECLARATION_BODY_NODE_TYPES.has(node.type)) {
			earliest = Math.min(earliest ?? Number.POSITIVE_INFINITY, node.startIndex);
			continue;
		}
		for (const child of node.namedChildren) {
			if (body !== null && child.id === body.id) continue;
			stack.push(child);
		}
	}
	return earliest;
}

interface UnitRelations {
	readonly definitions: string[];
	readonly references: string[];
	readonly calls: string[];
}

/** 提取当前代码单元拥有的词法关系，并跳过单独建索引的子单元。 */
export function extractUnitRelations(
	unit: RawUnit,
	unitNodeIds: ReadonlySet<number>,
	control: AnalysisControl,
): UnitRelations {
	const localDefinitions = unit.kind === "function" || unit.kind === "method"
		? new Set<string>()
		: undefined;
	const references = new Set<string>();
	const calls = new Set<string>();
	walkRelations(unit.sourceNode, unit.sourceNode.id, unitNodeIds, localDefinitions, references, calls, control);
	const definitions = localDefinitions ?? new Set<string>();
	if (unit.name !== undefined) definitions.add(unit.name);
	for (const definition of definitions) references.delete(definition);
	if (unit.qualifiedName !== undefined) references.delete(unit.qualifiedName);
	return { definitions: [...definitions], references: [...references], calls: [...calls] };
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
	let current: SyntaxNode | null = node;
	while (current !== null) {
		if (current.type === "function_declarator") return current;
		current = current.childForFieldName("declarator");
	}
	return undefined;
}

function namedDeclarator(node: SyntaxNode): string | undefined {
	let current: SyntaxNode | null = node;
	while (current !== null) {
		if (DECLARATOR_NAME_TYPES.has(current.type)) return current.text;
		current = current.childForFieldName("declarator");
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

const CALL_NODE_TYPES = new Set(["call", "call_expression", "command", "new_expression"]);
const STATIC_CALLEE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const IMPORT_NODE_TYPES = new Set([
	"import_declaration",
	"import_from_statement",
	"import_statement",
	"preproc_include",
	"use_declaration",
]);
const DEFINITION_FIELDS = new Map<string, readonly string[]>([
	["assignment", ["left"]],
	["catch_clause", ["parameter"]],
	["class_declaration", ["name"]],
	["class_definition", ["name"]],
	["const_item", ["name"]],
	["for_in_clause", ["left"]],
	["function_declaration", ["name"]],
	["function_definition", ["name"]],
	["let_declaration", ["pattern"]],
	["method_definition", ["name"]],
	["optional_parameter", ["pattern", "name"]],
	["parameter_declaration", ["declarator", "name"]],
	["required_parameter", ["pattern", "name"]],
	["short_var_declaration", ["left"]],
	["static_item", ["name"]],
	["variable_declarator", ["name"]],
]);
const PARAMETER_LIST_NODE_TYPES = new Set([
	"closure_parameters",
	"formal_parameters",
	"parameters",
]);
const EMPTY_NODE_IDS: ReadonlySet<number> = new Set();

function walkRelations(
	root: SyntaxNode,
	rootNodeId: number,
	unitNodeIds: ReadonlySet<number>,
	definitions: Set<string> | undefined,
	references: Set<string>,
	calls: Set<string>,
	control: AnalysisControl,
): void {
	const stack = [root];
	const definitionNodes = definitions === undefined ? undefined : new Set<number>();
	while (stack.length > 0) {
		control.check();
		const node = stack.pop();
		if (node === undefined) break;
		if (node.id !== rootNodeId && unitNodeIds.has(node.id)) continue;
		if (node.id !== rootNodeId && IMPORT_NODE_TYPES.has(node.type)) continue;
		const definition = definitionNodes?.delete(node.id) ?? false;
		const callable = callableNode(node);
		const children = node.namedChildren;
		if (callable !== undefined) {
			const target = staticCallee(callable);
			if (target !== undefined) calls.add(target);
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index];
				if (child === undefined || child.id === callable.id) continue;
				if (definition) definitionNodes?.add(child.id);
				stack.push(child);
			}
			if (target === undefined) {
				if (definition) definitionNodes?.add(callable.id);
				stack.push(callable);
			}
			continue;
		}
		if (isIdentifierLeaf(node)) {
			if (definition) definitions?.add(node.text);
			else references.add(node.text);
		}
		const definitionChildren = definitions === undefined ? EMPTY_NODE_IDS : definitionChildIds(node);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child === undefined) continue;
			if (definition || definitionChildren.has(child.id)) definitionNodes?.add(child.id);
			stack.push(child);
		}
	}
}

export function walkNamed(root: SyntaxNode, visit: (node: SyntaxNode) => void, control: AnalysisControl): void {
	const stack = [root];
	while (stack.length > 0) {
		control.check();
		const node = stack.pop();
		if (node === undefined) break;
		visit(node);
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push(child);
		}
	}
}

function callableNode(node: SyntaxNode): SyntaxNode | undefined {
	if (!CALL_NODE_TYPES.has(node.type)) return undefined;
	return node.childForFieldName("function")
		?? node.childForFieldName("constructor")
		?? node.childForFieldName("type")
		?? node.childForFieldName("name")
		?? undefined;
}

function staticCallee(node: SyntaxNode): string | undefined {
	if (node.type === "command_name" && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(node.text)) return node.text;
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

function definitionChildIds(node: SyntaxNode): ReadonlySet<number> {
	const fields = DEFINITION_FIELDS.get(node.type);
	if (!PARAMETER_LIST_NODE_TYPES.has(node.type) && fields === undefined) return EMPTY_NODE_IDS;
	const result = new Set<number>();
	if (PARAMETER_LIST_NODE_TYPES.has(node.type)) {
		for (const child of node.namedChildren) {
			if (isIdentifierLeaf(child) || child.type.endsWith("_pattern")) result.add(child.id);
		}
	}
	for (const field of fields ?? []) {
		for (const child of node.childrenForFieldName(field)) result.add(child.id);
	}
	return result;
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind);
}
