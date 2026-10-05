import type { AnalysisControl, SyntaxNode } from "../../syntax-tree/types.ts";
import { compactDeclaration } from "../text.ts";
import type { RawUnit } from "./types.ts";

export interface UnitRules {
	extract(node: SyntaxNode, scope: string | undefined, text: string): RawUnit | undefined;
	childScope(node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined;
	isContainer(node: SyntaxNode, unit: RawUnit): boolean;
}

export function collectUnits(root: SyntaxNode, text: string, rules: UnitRules, control: AnalysisControl): RawUnit[] {
	const units: RawUnit[] = [];
	const stack: Array<{ node: SyntaxNode; scope?: string; nested: boolean; ownedCallable?: number }> = [{ node: root, nested: false }];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		control.check();
		const { node, scope } = current;
		let unit = node.id === current.ownedCallable ? undefined : rules.extract(node, scope, text);
		// 函数内继续收集嵌套声明和回调，不将普通局部变量拆成搜索区域。
		if (current.nested && unit?.kind === "declaration" && unit.callableNode === undefined) unit = undefined;
		if (unit !== undefined) units.push(unit);
		const callable = unit?.callableNode;
		const childScope = callable !== undefined ? unit?.qualifiedName ?? scope : rules.childScope(node, unit, scope);
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push({
				node: child,
				nested: current.nested || (unit !== undefined && !rules.isContainer(node, unit)) || callable !== undefined,
				...(childScope === undefined ? {} : { scope: childScope }),
				...(unit?.ownedCallable === undefined ? {} : { ownedCallable: unit.ownedCallable }),
			});
		}
	}
	return units.sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind));
}

interface UnitStructure {
	readonly range?: SyntaxNode;
	readonly name?: SyntaxNode;
	readonly body?: SyntaxNode | null | undefined;
	readonly callable?: SyntaxNode;
	readonly ownedCallable?: number;
	readonly context?: string;
}

/** 只投影适配器已识别的节点，不猜测语言的字段或节点类型。 */
export function rawUnit(node: SyntaxNode, kind: string, name: string | undefined, scope: string | undefined, structure: UnitStructure): RawUnit {
	const range = structure.range ?? node;
	return {
		kind,
		...(name === undefined ? {} : { name, qualifiedName: scope === undefined ? name : `${scope}.${name}` }),
		...(structure.name === undefined ? {} : { nameNode: structure.name }),
		...(structure.body == null ? {} : { bodyNode: structure.body, declarationEndChar: structure.body.startIndex }),
		...(structure.callable === undefined ? {} : { callableNode: structure.callable }),
		...(structure.ownedCallable === undefined ? {} : { ownedCallable: structure.ownedCallable }),
		...(structure.context === undefined ? {} : { context: structure.context }),
		startChar: range.startIndex,
		endChar: range.endIndex,
	};
}

/** 单标识符绑定和匿名表达式共用范围投影，绑定及调用前缀由语言适配器识别。 */
export function functionUnit(node: SyntaxNode, scope: string | undefined, text: string, body: SyntaxNode | null,
	binding?: { name: SyntaxNode; declaration: SyntaxNode }, call?: SyntaxNode | null): RawUnit {
	let start = call?.startIndex ?? node.startIndex;
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	if (/^\s*(?:return\s+)?$/u.test(text.slice(lineStart, start))) start = lineStart;
	const end = body?.startIndex ?? node.endIndex;
	return {
		...rawUnit(node, "function", binding?.name.text, scope, {
			...(binding === undefined ? { context: compactDeclaration(text.slice(start, end + (text[end] === "{" ? 1 : 0))) } : { name: binding.name }),
			body, callable: node,
		}),
		startChar: binding?.declaration.startIndex ?? node.startIndex,
	};
}

export function nameField(node: SyntaxNode): string | undefined {
	return node.childForFieldName("name")?.text;
}

export function firstNamedChildText(node: SyntaxNode, types: readonly string[]): string | undefined {
	return node.namedChildren.find((child) => types.includes(child.type))?.text;
}
