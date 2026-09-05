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
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (DYNAMIC_NODE_TYPES.has(node.type)) return true;
		stack.push(...node.namedChildren);
	}
	return false;
}

interface ShellWordOptions {
	allowUnquotedExpansion?: boolean;
	allowGlob?: boolean;
	resolveExpansion?: (source: string, start: number, prefix: string) => { value: string; end: number } | undefined;
}

/** 解码单个 Shell word。引号与转义共用一套规则，动态展开由调用方提供。 */
export function decodeShellWord(source: string, options: ShellWordOptions = {}): string | undefined {
	let result = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source.charAt(index);
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (character === "\"") {
			quote = quote === "\"" ? undefined : "\"";
			continue;
		}
		if (character === "'" && quote === undefined) {
			quote = "'";
			continue;
		}
		if (character === "\\") {
			const next = source[index + 1];
			if (next === undefined) return undefined;
			index += 1;
			if (next === "\n") continue;
			if (quote === "\"" && next !== "$" && next !== "`" && next !== "\"" && next !== "\\") result += "\\";
			result += next;
			continue;
		}
		if (character === "$") {
			if (quote === undefined && options.allowUnquotedExpansion !== true) return undefined;
			const expansion = options.resolveExpansion?.(source, index, result);
			if (expansion === undefined) return undefined;
			result += expansion.value;
			index = expansion.end;
			continue;
		}
		if (character === "`") return undefined;
		if (quote === undefined && (character === "*" || character === "?" || character === "[") && options.allowGlob !== true) return undefined;
		if (quote === undefined && character === "{") return undefined;
		if (quote === undefined && character === "~" && index === 0) return undefined;
		result += character;
	}
	return quote === undefined ? result : undefined;
}
