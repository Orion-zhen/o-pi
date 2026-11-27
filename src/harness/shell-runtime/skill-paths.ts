import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadedSkillsByName } from "../skill-context/state.ts";
import { resolveSkillResourceLocator, type SkillResourceError } from "../skill-context/resources.ts";
import { containsDynamicShellNode, decodeShellWord } from "../syntax-tree/bash.ts";
import { POWERSHELL_GRAMMAR, TREE_SITTER_LANGUAGES } from "../syntax-tree/grammars.ts";
import { parseSyntaxTree, SyntaxAnalysisTimeoutError } from "../syntax-tree/parser.ts";
import { powerShellCodeInput, powerShellCommand, powerShellRedirect, type PowerShellRedirectTarget } from "../syntax-tree/powershell.ts";
import type { SyntaxTreeDocument } from "../syntax-tree/types.ts";
import type { ShellName } from "./platform.ts";

interface SkillWord { start: number; end: number; locator: string; usage?: "invoke" | "redirect" }

/** 按各自语法选择完整参数，两种 Shell 共用本次调用的技能授权和路径替换流程。 */
export async function resolveShellSkillPaths(
	shell: ShellName, command: string, session: Pick<ExtensionContext["sessionManager"], "getBranch">, signal?: AbortSignal,
): Promise<{ kind: "resolved"; command: string } | SkillResourceError> {
	if (!command.includes("skill://")) return { kind: "resolved", command };
	const loads = loadedSkillsByName(session.getBranch());
	const bash = shell === "bash";
	const tree = await parseSyntaxTree(bash ? TREE_SITTER_LANGUAGES.bash.grammar : POWERSHELL_GRAMMAR, command, signal);
	const invalid = (message: string): SkillResourceError => ({ kind: "error", code: "invalid-locator", message, path: command });
	let words: SkillWord[];
	try {
		if (!tree || tree.root.hasError) return invalid(`${bash ? "Bash" : "PowerShell"} command containing a skill resource must have valid shell syntax.`);
		words = bash ? bashSkillWords(tree) : powerShellSkillWords(tree, command);
	} catch (error) {
		if (!(error instanceof SyntaxAnalysisTimeoutError)) throw error;
		return invalid("Shell skill path analysis exceeded its deadline.");
	} finally { tree?.dispose(); }
	if (!words.length) return invalid("A skill resource must be a complete static shell argument.");
	const resources = await Promise.all(words.map(async (word) => ({ word, resource: await resolveSkillResourceLocator(word.locator, loads) })));
	signal?.throwIfAborted();
	let cursor = 0, script = "";
	for (const { word: { start, end, usage }, resource } of resources) {
		if (resource.kind === "error") return resource;
		// PowerShell 重定向会再次按通配模式解析路径，单引号不能使它指向同一个文件。
		if (usage === "redirect" && /[`*?\[\]]/u.test(resource.filePath)) return invalid("PowerShell redirection cannot use a resource path with wildcard syntax.");
		// PowerShell 也把弯单引号当作分隔符，路径中的引号必须成对转义。
		const quoted = bash ? `'${resource.filePath.replaceAll("'", `'"'"'`)}'` : `'${resource.filePath.replace(/['\u2018-\u201b]/gu, "$&$&")}'`;
		script += command.slice(cursor, start) + (usage === "invoke" ? "& " : "") + quoted;
		cursor = end;
	}
	return { kind: "resolved", command: script + command.slice(cursor) };
}

const bashWordTypes = new Set(["raw_string", "string", "word"]);

function bashSkillWords(tree: SyntaxTreeDocument): SkillWord[] {
	const words: SkillWord[] = [], stack = [tree.root];
	for (let node = stack.pop(); node; node = stack.pop()) {
		tree.control.check();
		if (node.type === "comment" || node.type === "heredoc_body") continue;
		if (bashWordTypes.has(node.type)) {
			const locator = decodeShellWord(node.text);
			if (locator?.startsWith("skill://")) {
				words.push({ start: node.startIndex, end: node.endIndex, locator });
				continue;
			}
			if (containsDynamicShellNode(node) && /^["']?skill:\/\//u.test(node.text)) return [];
		}
		for (const child of [...node.namedChildren].reverse()) stack.push(child);
	}
	return words;
}

function powerShellSkillWords(tree: SyntaxTreeDocument, command: string): SkillWord[] {
	const words: SkillWord[] = [], stack = [tree.root];
	function add(start: number, end: number, locator: string | undefined, usage?: SkillWord["usage"]) {
		if (locator?.startsWith("skill://") && (end === command.length || /[\s;|)}]/u.test(command.charAt(end)))) {
			words.push({ start, end, locator, ...(usage && { usage }) });
		}
	}
	function redirect(target: PowerShellRedirectTarget) {
		if (target.range) add(target.range.start, target.range.end, target.value, "redirect");
		if (target.expression && target.value === undefined) stack.push(target.expression);
	}
	for (let node = stack.pop(); node; node = stack.pop()) {
		tree.control.check();
		if (node.type === "command") {
			const { name, operator, args, redirects } = powerShellCommand(node, command, tree.control.check);
			if (!redirects.every(r => "value" in r) || args.some(arg => !arg.bounded)) continue;
			for (const target of redirects) redirect(target);
			if (name.value) {
				if (powerShellCodeInput(name.value, args)) continue;
				add(name.start, name.end, name.value, operator ? undefined : "invoke");
			} else if (operator && name.expression?.firstNamedChild?.type === "script_block_expression") {
				stack.push(name.expression);
			} else continue;
			for (const arg of args) {
				add(arg.start, arg.end, arg.value);
				if (arg.expression && arg.value === undefined) stack.push(arg.expression);
			}
			continue;
		}
		if (node.type === "redirection") {
			const target = powerShellRedirect(node);
			if (target) redirect(target);
			continue;
		}
		for (const child of node.namedChildren.toReversed()) stack.push(child);
	}
	// 外层参数可能位于内层命令之后。按源码顺序一次替换，存在未认领的定位符就拒绝整条命令。
	words.sort((a, b) => a.start - b.start);
	let cursor = 0;
	for (const { start, end } of words) {
		if (start < cursor || command.slice(cursor, start).includes("skill://")) return [];
		cursor = end;
	}
	return command.slice(cursor).includes("skill://") ? [] : words;
}
