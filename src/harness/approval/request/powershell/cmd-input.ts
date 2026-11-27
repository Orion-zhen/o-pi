import path from "node:path";
import { powerShellCommand, type PowerShellWord } from "../../../syntax-tree/powershell.ts";
import type { SyntaxTreeDocument } from "../../../syntax-tree/types.ts";
import type { ShellArg, ShellArgv } from "../../types.ts";
import { filePath, type Location } from "./locations.ts";

const unknown = { source: "?", unresolved: true } as const;
const flag = /^\/[a-z]+$/iu;

/** 只展开直接调用。cmd 的环境展开和不确定的引号边界不能证明路径。 */
export function cmdInput(name: string, args: PowerShellWord[], values: (string | undefined)[], positions: Location[]): ShellArgv[] {
	if (!/^(?:cmd|cmd\.exe)$/iu.test(path.win32.basename(name))) return [];
	let i = 0;
	while (/^\/(?:d|s|q|[vef]:(?:on|off))$/iu.test(values[i] ?? "")) i++;
	if (values[i++]?.toLowerCase() !== "/c") return [];
	const first = args[i];
	if (!first) return [];
	// 单个脚本参数内保留已知命令与开关，不把未解析的插值当字面路径。
	const source = first.source;
	const body = values[i] ?? partialString(source);
	if (!body) return [];
	const words: ShellArg[] = [];
	const tokens = /[ \t]+|(?:"[^"\r\n]*"|[^\s"&|<>^()])+/uy;
	while (tokens.lastIndex < body.length) {
		const text = tokens.exec(body)?.[0];
		if (text === undefined) { words.push(unknown); break; }
		if (/^[ \t]/u.test(text)) continue;
		words.push(/[%!\0]/u.test(text) ? unknown : text.replaceAll('"', ''));
	}
	for (const value of values.slice(i + 1)) {
		if (value !== undefined && /[&|<>^()\r\n]/u.test(value)) { words.push(unknown); break; }
		words.push(value === undefined || /[%!"\0]/u.test(value) ? unknown : value);
	}
	const program = words.shift();
	if (typeof program !== "string" || !/^[\w.-]+$/u.test(program)) return [];
	return positions.map(([cwd]) => [`cmd:${program.toLowerCase()}`, ...words.map(word => {
		if (typeof word !== "string") return word;
		if (flag.test(word)) return word.toLowerCase();
		if (word === "\\" || word === "/") return "/";
		return filePath(word, cwd) ?? unknown;
	})]);
}

function partialString(source: string): string | undefined {
	if (!source.startsWith('"')) return;
	const masked = source.slice(1, -1).replace(/\$(?:\{(?:env:)?\w+\}|(?:env:)?\w+)/giu, "\0");
	if (source.endsWith('"') && /^(?:`"|[^"`$\r\n])*$/u.test(masked)) return masked.replaceAll('`"', '"');
	const prefix = /^"([^"`$\r\n]*)[`$]/u.exec(source)?.[1];
	return prefix === undefined ? undefined : prefix + "\0";
}

/** grammar 在闭合引号后紧邻变量时可能只保留首个完整参数。未知尾部不能抹掉已知参数，也不能消除原解析错误。 */
export function partialCmdInputs(tree: SyntaxTreeDocument, code: string): ShellArgv[] {
	const commands: ShellArgv[] = [];
	for (const node of tree.root.descendantsOfType("command")) {
		tree.control.check();
		if (node.hasError || code[node.endIndex] !== "$") continue;
		let parent = node.parent;
		while (parent && ["ERROR", "pipeline", "pipeline_chain", "statement_list", "program"].includes(parent.type)) parent = parent.parent;
		if (parent) continue;
		const { name, args } = powerShellCommand(node, code, tree.control.check), last = args.at(-1);
		if (name.value && last?.value !== undefined && /^".*"$/su.test(last.source) && last.end === node.endIndex) {
			commands.push(...cmdInput(name.value, args, [...args.map(a => a.value), undefined], [[undefined]]));
		}
	}
	return commands;
}
