import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.js";
import type { RawUnit } from "./types.js";

export interface UnitRules {
	extract(node: SyntaxNode, scope: string | undefined): RawUnit | undefined;
	childScope(node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined;
	shouldDescend(node: SyntaxNode, unit: RawUnit): boolean;
}

export function collectUnits(root: SyntaxNode, rules: UnitRules, control: AnalysisControl): RawUnit[] {
	const units: RawUnit[] = [];
	const stack: Array<{ node: SyntaxNode; scope: string | undefined }> = [{ node: root, scope: undefined }];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		control.check();
		const { node, scope } = current;
		const unit = rules.extract(node, scope);
		if (unit !== undefined) units.push(unit);
		if (unit !== undefined && !rules.shouldDescend(node, unit)) continue;
		const childScope = rules.childScope(node, unit, scope);
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push({ node: child, scope: childScope });
		}
	}
	return units.sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind));
}

export function rawUnit(node: SyntaxNode, kind: string, name: string, scope?: string, exported = false): RawUnit {
	const range = node.parent?.type === "export_statement" ? node.parent : node;
	const declarationEndChar = node.childForFieldName("body")?.startIndex ?? nestedBodyStart(node);
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
	"class_body", "declaration_list", "enum_variant_list", "field_declaration_list", "interface_body",
]);

function nestedBodyStart(root: SyntaxNode): number | undefined {
	let earliest: number | undefined;
	const stack = [...root.namedChildren];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
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

export function nameField(node: SyntaxNode): string | undefined {
	return node.childForFieldName("name")?.text;
}

export function firstNamedChildText(node: SyntaxNode, types: readonly string[]): string | undefined {
	return node.namedChildren.find((child) => types.includes(child.type))?.text;
}

export function walkNamed(root: SyntaxNode, visit: (node: SyntaxNode) => void, control: AnalysisControl): void {
	const stack = [root];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		control.check();
		visit(node);
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push(child);
		}
	}
}
