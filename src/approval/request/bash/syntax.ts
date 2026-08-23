import { containsDynamicShellNode, decodeStaticShellWord } from "../../../syntax-tree/bash.js";
import type { SyntaxNode } from "../../../syntax-tree/types.js";

export function* walkNamedNodes(root: SyntaxNode, check: () => void): Generator<SyntaxNode> {
	const stack = [root];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		check();
		yield node;
		for (const child of [...node.namedChildren].reverse()) stack.push(child);
	}
}

export function* walkNamedNodesSkippingFunctions(root: SyntaxNode, check: () => void): Generator<SyntaxNode> {
	const stack = [root];
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		check();
		yield node;
		if (node !== root && node.type === "function_definition") continue;
		for (const child of [...node.namedChildren].reverse()) stack.push(child);
	}
}

export function normalizeCommandNode(node: SyntaxNode): string {
	const parts = node.namedChildren
		.filter((child) => child.type !== "file_redirect" && child.type !== "heredoc_redirect" && child.type !== "herestring_redirect")
		.map((child) => normalizeSource(child.text))
		.filter((part) => part.length > 0);
	return parts.length === 0 ? normalizeSource(node.text) : parts.join(" ");
}

export function literalNodeText(node: SyntaxNode): string | undefined {
	if (containsDynamicShellNode(node)) return undefined;
	return decodeStaticShellWord(node.text);
}

export function normalizeSource(value: string): string {
	let result = "";
	let quote: "'" | "\"" | undefined;
	let pendingSpace = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value.charAt(index);
		if (quote !== undefined) {
			result += character;
			if (quote === "\"" && character === "\\") {
				const next = value[index + 1];
				if (next !== undefined) {
					result += next;
					index += 1;
				}
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (/\s/u.test(character)) {
			pendingSpace = result.length > 0;
			continue;
		}
		if (pendingSpace) {
			result += " ";
			pendingSpace = false;
		}
		result += character;
		if (character === "'" || character === "\"") quote = character;
		else if (character === "\\") {
			const next = value[index + 1];
			if (next !== undefined) {
				result += next;
				index += 1;
			}
		}
	}
	return result;
}
