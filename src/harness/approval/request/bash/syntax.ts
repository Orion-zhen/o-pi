import { containsDynamicShellNode, decodeShellWord } from "../../../syntax-tree/bash.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";

export function requiredField(node: SyntaxNode, name: string): SyntaxNode {
	const child = node.childForFieldName(name);
	if (child === null) throw new Error(`Missing Bash syntax field: ${node.type}.${name}`);
	return child;
}

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

// Shell 参数不能包含 NUL。标记仅在值分析中传播，不能作为命令参数或精确路径。
export const NUMERIC_FIELD = "\0number\0";

/** 仅替换语法树中的 PID 和退出状态展开。引号、转义及其他变量仍由共用的单词解码器处理。 */
export function shellWordSource(node: SyntaxNode): string | undefined {
	const source = node.text;
	if (!/\$(?:[$?]|\{[$?]\})/u.test(source)) return source;
	const stack = [node];
	let marked = "";
	let offset = 0;
	for (let part = stack.pop(); part !== undefined; part = stack.pop()) {
		if (part.type === "simple_expansion" || part.type === "expansion") {
			if (!/^\$(?:[$?]|\{[$?]\})$/u.test(part.text)) continue;
			marked += source.slice(offset, part.startIndex - node.startIndex) + NUMERIC_FIELD;
			offset = part.endIndex - node.startIndex;
		} else if (part.type === "string" || part.type === "concatenation" || part.type === "command_name") {
			stack.push(...part.namedChildren.toReversed());
		} else if (part.type !== "word" && part.type !== "string_content" && part.type !== "raw_string") return undefined;
	}
	return marked + source.slice(offset);
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

// 只替换命令名，参数的引号、转义和续行由执行该命令的 Bash 解释。
export function staticSudoCommand(script: string, root: SyntaxNode): string | undefined {
	if (!/^[ \t\n]*(?:\/usr\/bin\/)?sudo[ \t]/u.test(script) || root.childCount !== 1) return;
	const command = root.firstChild;
	if (command?.type !== "command") return;
	const [name, ...args] = command.children;
	if (name?.type !== "command_name" || (name.text !== "sudo" && name.text !== "/usr/bin/sudo")) return;
	if (!args.every((arg) => ["word", "string", "raw_string", "number"].includes(arg.type))) return;
	const [, program, ...rest] = commandWords(command);
	if (!program?.literal || program.literal.startsWith("-") || program.literal.includes("=") || rest.some((arg) => arg.literal === undefined)) return;
	return `exec /usr/bin/sudo -A --${script.slice(name.endIndex)}`;
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
