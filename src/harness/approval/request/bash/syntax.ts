import { containsDynamicShellNode, decodeShellWord } from "../../../syntax-tree/bash.js";
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
		.filter((child) => child.text.trim().length > 0);
	let source = "";
	let end: number | undefined;
	for (const child of parts) {
		const gap = end === undefined ? "" : node.text.slice(end - node.startIndex, child.startIndex - node.startIndex);
		source += (end === undefined ? "" : isWordContinuation(gap) ? gap : " ") + child.text;
		end = child.endIndex;
	}
	return normalizeSource(parts.length === 0 ? node.text : source);
}

function literalNodeText(node: SyntaxNode): string | undefined {
	if (containsDynamicShellNode(node)) return undefined;
	return decodeShellWord(node.text);
}

/** Tree-sitter 会把单词中间的续行拆成相邻 word，这里恢复实际的参数边界。 */
export function commandWords(node: SyntaxNode): Array<{ node: SyntaxNode; source: string; literal: string | undefined }> {
	const name = node.childForFieldName("name");
	const nodes = [...(name === null ? [] : [name]), ...node.childrenForFieldName("argument")];
	const words: Array<{ node: SyntaxNode; source: string; literal: string | undefined }> = [];
	let end: number | undefined;
	for (const child of nodes) {
		const previous = words.at(-1);
		const gap = end === undefined ? "" : node.text.slice(end - node.startIndex, child.startIndex - node.startIndex);
		const literal = literalNodeText(child);
		if (previous !== undefined && isWordContinuation(gap)) {
			previous.source += gap + child.text;
			previous.literal = previous.literal === undefined || literal === undefined ? undefined : decodeShellWord(previous.source);
		} else words.push({ node: child, source: child.text, literal });
		end = child.endIndex;
	}
	return words;
}

function isWordContinuation(gap: string): boolean {
	return /^(?:\\\n)+$/u.test(gap);
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
