import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { resolveSkillResourceLocator, type SkillResourceError } from "../skill-context/resources.js";
import { containsDynamicShellNode, decodeShellWord } from "../syntax-tree/bash.js";
import { getTreeSitterLanguage } from "../syntax-tree/grammars.js";
import { parseSyntaxTree } from "../syntax-tree/parser.js";
import type { SyntaxNode } from "../syntax-tree/types.js";

const BASH_GRAMMAR = getTreeSitterLanguage("bash").grammar;
const SHELL_WORD_TYPES = new Set(["raw_string", "string", "word"]);

interface ResolvedBashSkillPaths {
	kind: "resolved";
	command: string;
}

interface Replacement {
	start: number;
	end: number;
	value: string;
}

/** 将命令中的静态 skill:// shell 参数替换为安全引用的已授权真实路径。 */
export async function resolveBashSkillPaths(
	command: string,
	branch: SessionEntry[],
	signal?: AbortSignal,
): Promise<ResolvedBashSkillPaths | SkillResourceError> {
	if (!command.includes("skill://")) return { kind: "resolved", command };
	const document = await parseSyntaxTree(BASH_GRAMMAR, command, signal === undefined ? {} : { signal });
	if (document === undefined) {
		return invalid(command, "Bash command containing a skill resource must have valid shell syntax.");
	}
	if (document.root.hasError) {
		document.dispose();
		return invalid(command, "Bash command containing a skill resource must have valid shell syntax.");
	}

	try {
		const candidates = collectCandidates(document.root, document.control.check);
		const resolved = await Promise.all(candidates.map(async (candidate): Promise<Replacement | SkillResourceError> => {
			const locator = decodeShellWord(candidate.text);
			if (locator === undefined || !locator.startsWith("skill://")) {
				return invalid(candidate.text, "A skill resource must be a complete static shell argument.");
			}
			const resource = await resolveSkillResourceLocator(locator, branch);
			if (resource.kind === "error") return resource;
			return { start: candidate.startIndex, end: candidate.endIndex, value: quoteShellWord(resource.filePath) };
		}));
		const error = resolved.find((item): item is SkillResourceError => "kind" in item && item.kind === "error");
		if (error !== undefined) return error;
		const replacements = resolved.filter((item): item is Replacement => !("kind" in item));
		if (replacements.length === 0) {
			return invalid(command, "A skill resource must be a complete static shell argument.");
		}
		return { kind: "resolved", command: applyReplacements(command, replacements) };
	} finally {
		document.dispose();
	}
}

function collectCandidates(root: SyntaxNode, check: () => void): SyntaxNode[] {
	const candidates: SyntaxNode[] = [];
	const stack = [root];
	while (stack.length > 0) {
		check();
		const node = stack.pop();
		if (node === undefined) break;
		if (node.type === "comment" || node.type === "heredoc_body") continue;
		if (SHELL_WORD_TYPES.has(node.type) && tokenStartsWithSkillLocator(node)) {
			candidates.push(node);
			continue;
		}
		for (const child of [...node.namedChildren].reverse()) stack.push(child);
	}
	return candidates;
}

function tokenStartsWithSkillLocator(node: SyntaxNode): boolean {
	const decoded = decodeShellWord(node.text);
	if (decoded?.startsWith("skill://") === true) return true;
	if (!containsDynamicShellNode(node)) return false;
	const source = node.text;
	return source.startsWith("skill://")
		|| source.startsWith("\"skill://")
		|| source.startsWith("'skill://");
}

function quoteShellWord(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function applyReplacements(command: string, replacements: Replacement[]): string {
	let result = command;
	for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
	}
	return result;
}

function invalid(inputPath: string, message: string): SkillResourceError {
	return { kind: "error", code: "invalid-locator", message, path: inputPath };
}
