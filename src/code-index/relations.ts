import type { AnalysisControl, SyntaxNode } from "../syntax-tree/types.js";
import type { RawUnit } from "./adapters/types.js";

const CALL_NODE_TYPES = new Set(["call", "call_expression", "command", "new_expression"]);
const STATIC_CALLEE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const IMPORT_NODE_TYPES = new Set([
	"import_declaration", "import_from_statement", "import_statement", "preproc_include", "use_declaration",
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
const PARAMETER_LIST_NODE_TYPES = new Set(["closure_parameters", "formal_parameters", "parameters"]);

/** 提取本单元的词法关系，跳过已单独索引的子单元与导入。 */
export function extractUnitRelations(unit: RawUnit, unitNodeIds: ReadonlySet<number>, control: AnalysisControl) {
	const definitions = new Set<string>();
	const references = new Set<string>();
	const calls = new Set<string>();
	const collectDefinitions = unit.kind === "function" || unit.kind === "method";
	const stack = [{ node: unit.sourceNode, isDefinition: false }];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		control.check();
		const { node, isDefinition } = current;
		if (node.id !== unit.sourceNode.id && (unitNodeIds.has(node.id) || IMPORT_NODE_TYPES.has(node.type))) continue;
		const callable = callableNode(node);
		const children = node.namedChildren;
		if (callable !== undefined) {
			const target = staticCallee(callable);
			if (target !== undefined) calls.add(target);
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index];
				if (child !== undefined && child.id !== callable.id) stack.push({ node: child, isDefinition });
			}
			if (target === undefined) stack.push({ node: callable, isDefinition });
			continue;
		}
		if (isIdentifierLeaf(node)) {
			if (isDefinition) definitions.add(node.text);
			else references.add(node.text);
		}
		const definitionChildren = collectDefinitions ? definitionChildIds(node) : undefined;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push({ node: child, isDefinition: isDefinition || definitionChildren?.has(child.id) === true });
		}
	}
	definitions.add(unit.name);
	for (const definition of definitions) references.delete(definition);
	references.delete(unit.qualifiedName);
	return { definitions: [...definitions], references: [...references], calls: [...calls] };
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
	const normalized = node.text.replace(/\s+/gu, "").replaceAll("?.", ".").replaceAll("->", ".").replaceAll("::", ".");
	return STATIC_CALLEE.test(normalized) ? normalized : undefined;
}

function isIdentifierLeaf(node: SyntaxNode): boolean {
	return node.namedChildren.length === 0 && (node.type === "identifier" || node.type.endsWith("_identifier"));
}

function definitionChildIds(node: SyntaxNode): ReadonlySet<number> | undefined {
	const fields = DEFINITION_FIELDS.get(node.type);
	const parameters = PARAMETER_LIST_NODE_TYPES.has(node.type);
	if (!parameters && fields === undefined) return undefined;
	const result = new Set<number>();
	if (parameters) {
		for (const child of node.namedChildren) {
			if (isIdentifierLeaf(child) || child.type.endsWith("_pattern")) result.add(child.id);
		}
	}
	for (const field of fields ?? []) {
		for (const child of node.childrenForFieldName(field)) result.add(child.id);
	}
	return result;
}
