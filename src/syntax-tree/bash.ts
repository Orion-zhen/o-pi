import type { SyntaxNode } from "./types.js";

const DYNAMIC_NODE_TYPES = new Set([
	"arithmetic_expansion",
	"brace_expansion",
	"command_substitution",
	"expansion",
	"extglob_pattern",
	"process_substitution",
	"simple_expansion",
]);

export function containsDynamicShellNode(root: SyntaxNode): boolean {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if (DYNAMIC_NODE_TYPES.has(node.type)) return true;
		for (const child of node.namedChildren) stack.push(child);
	}
	return false;
}

/** 解码不包含动态展开的单个 Shell word；无法静态确定时返回 undefined。 */
export function decodeStaticShellWord(source: string): string | undefined {
	let result = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === undefined) break;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (quote === "\"") {
			if (character === "\"") {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const next = source[index + 1];
				if (next === undefined) return undefined;
				if (next === "\n") {
					index += 1;
					continue;
				}
				result += next === "$" || next === "`" || next === "\"" || next === "\\" ? next : `\\${next}`;
				index += 1;
				continue;
			}
			if (character === "$" || character === "`") return undefined;
			result += character;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			continue;
		}
		if (character === "\\") {
			const next = source[index + 1];
			if (next === undefined) return undefined;
			result += next;
			index += 1;
			continue;
		}
		if (character === "$" || character === "`" || character === "*" || character === "?" || character === "[" || character === "{") {
			return undefined;
		}
		if (character === "~" && index === 0) return undefined;
		result += character;
	}
	return quote === undefined ? result : undefined;
}
