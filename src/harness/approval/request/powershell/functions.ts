import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { PowerShellWord } from "../../../syntax-tree/powershell.ts";
import { choices, variable, type Flow, type Scalar } from "./flow.ts";

interface FunctionBinding { bodies: ReadonlyMap<number, SyntaxNode>; definite: boolean }
export type FunctionTable = Map<string, FunctionBinding>;

export function visibleFunctions(key: string, functions: FunctionTable) {
	const local = functions.get(key), script = functions.get(`script:${key}`);
	return { bodies: [...local?.bodies.values() ?? [], ...script?.bodies.values() ?? []], definite: !!(local?.definite || script?.definite) };
}

export function declareFunction(node: SyntaxNode, functions: FunctionTable, replace: boolean) {
	const name = node.namedChildren.find(child => child.type === "function_name")?.text.toLowerCase();
	if (!name) throw new Error("Missing PowerShell function_name node.");
	const key = name.replace(/^global:/u, "script:").replace(/^(?:local|private):/u, "");
	const prior = functions.get(key);
	const bodies = new Map(replace ? undefined : prior?.bodies).set(node.id, node);
	functions.set(key, { bodies, definite: replace || prior?.definite === true });
}

/** 无法展开的循环中，首句也可能看到上一次执行留下的定义。 */
export function collectFunctions(children: SyntaxNode[], functions: FunctionTable, check: () => void) {
	const stack = children.toReversed();
	for (let node = stack.pop(); node; node = stack.pop()) {
		check();
		if (node.type === "script_block_expression") continue;
		if (node.type !== "function_statement") {
			for (const child of node.namedChildren.toReversed()) stack.push(child);
			continue;
		}
		declareFunction(node, functions, false);
	}
}

function parameters(definition: SyntaxNode): { name: string; stringType: boolean }[] | undefined {
	const body = definition.namedChildren.find(n => n.type === "script_block");
	const declaration = definition.namedChildren.find(n => n.type === "function_parameter_declaration") ?? body?.namedChildren.find(n => n.type === "param_block");
	const parts = declaration?.namedChildren.filter(n => n.type !== "comment") ?? [];
	if (!parts.length) return [];
	const [list] = parts;
	if (parts.length !== 1 || list?.type !== "parameter_list") return;
	const names = [];
	for (const node of list.namedChildren) {
		const match = /^(\[string\]\s*)?(\$[a-z_]\w*)$/iu.exec(node.text);
		const key = match?.[2] && variable(match[2]);
		if (!key || key.scope !== "local") return;
		names.push({ name: key.name, stringType: Boolean(match?.[1]) });
	}
	return names;
}

/** 普通标量按位置或完整参数名绑定。未知类型转换不参与值推断。 */
export function bindFunction(definition: SyntaxNode, words: PowerShellWord[], variants: Scalar[][], strings: boolean[], flow: Flow): boolean {
	flow.args = [];
	const params = parameters(definition);
	if (!params) return false;
	const named = new Map<string, number>(), positional: number[] = [];
	const entries = words.entries();
	for (const [i, word] of entries) {
		if (word.source.startsWith("-")) {
			const key = word.source.slice(1).toLowerCase();
			const next = entries.next();
			if (!params.some(p => p.name === key) || named.has(key) || next.done || next.value[1].source.startsWith("-")) return false;
			named.set(key, next.value[0]);
		} else positional.push(i);
	}
	let offset = 0;
	for (const { name, stringType } of params) {
		const index = named.get(name) ?? positional[offset++];
		const isString = index !== undefined && strings[index] === true;
		if (stringType && !isString) return false;
		flow.locals.set(name, { values: index === undefined ? [undefined] : choices(variants.map(args => args[index])), type: isString ? "string" : "unknown" });
	}
	flow.args = positional.slice(offset).map(index => choices(variants.map(args => args[index])));
	return true;
}
