import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { PowerShellWord } from "../../../syntax-tree/powershell.ts";
import { gitScopeVariable, temporaryGitDirectories } from "../../rules/command-syntax.ts";
import { isSystemTemporaryDescendant } from "../path.ts";
import { filePath } from "./locations.ts";
import { variable, type Environment, type Flow, type Scalar } from "./flow.ts";
import { scalar } from "./values.ts";

// 这些命令按 PowerShell 参数绑定，而非原生进程的 argv 解释冒号和逗号。
export const modeledCmdlets = new Set(["get-command", "write-output", "get-item", "get-content", "get-date", "get-childitem", "resolve-path", "join-path", "new-item", "set-location", "push-location", "pop-location", "remove-item", "select-object", "select-string", "sort-object", "where-object", "foreach-object", "out-string"]);

export function wordValues(word: Pick<PowerShellWord, "value" | "expression">, flow: Flow, env: Environment): Scalar[] {
	if (word.value !== undefined) return [word.value];
	return (word.expression && scalar(word.expression, flow, env)?.values) ?? [undefined];
}

export function argumentsFor(words: PowerShellWord[], flow: Flow, env: Environment, limit: number): Scalar[][] {
	let variants: Scalar[][] = [[]];
	const slots = new Map<string, number>();
	for (const [i, word] of words.entries()) {
		const key = word.value === undefined && variable(word.source);
		const id = key ? `${key.scope}:${key.name}` : undefined;
		// 两次读取之间若有未建模的表达式，不假定变量仍取同一候选。
		if (!id && word.value === undefined) slots.clear();
		const slot = id === undefined ? undefined : slots.get(id);
		if (slot !== undefined) { for (const args of variants) args.push(args[slot]); continue; }
		const values = wordValues(word, flow, env);
		if (id && values.length > 1) slots.set(id, i);
		// 只放弃当前参数的精确值，后面的字面参数仍参与规则匹配。
		if (values.length > 1 && variants.length * values.length <= limit) variants = variants.flatMap(args => values.map(value => [...args, value]));
		else for (const args of variants) args.push(values.length === 1 ? values[0] : undefined);
	}
	return variants;
}

export function standalone(node: SyntaxNode): boolean {
	let parent = node.parent;
	while (parent?.type === "pipeline_chain" || parent?.type === "pipeline") {
		if (parent.text.trim() !== node.text.trim()) return false;
		parent = parent.parent;
	}
	return parent?.type === "statement_list" && parent.parent?.type === "program";
}

// 名称表的显式变更与普通命令的未知副作用分开处理。模块限定名和内置别名同样有效。
const bindingCommands = new Set([
	"set-alias", "sal", "new-alias", "nal", "remove-alias", "import-alias", "ipal",
	"import-module", "ipmo", "remove-module", "rmo", "new-module", "import-pssession", "add-pssnapin", "remove-pssnapin",
]);
const providerWriters = new Set([
	"set-item", "si", "new-item", "ni", "remove-item", "ri", "rm", "del", "erase", "rd", "rmdir", "clear-item", "cli",
	"copy-item", "cpi", "cp", "copy", "move-item", "mi", "mv", "move", "rename-item", "rni", "ren",
	"set-content", "sc", "add-content", "ac", "clear-content", "clc",
]);
export function changesCommandBindings(name: string, args: Scalar[]): boolean {
	const cmd = name.slice(name.lastIndexOf("\\") + 1);
	return bindingCommands.has(cmd) || providerWriters.has(cmd) && args.some(a => a !== undefined && /(?:^|\\|::)(?:alias|function):/iu.test(a));
}

export function writesSessionState(name: string, args: Scalar[], flow: Flow): boolean {
	const cmd = name.slice(name.lastIndexOf("\\") + 1);
	return /^(?:(?:set|new|remove|clear)-variable|sv|set|nv|rv|clv)$/u.test(cmd)
		|| providerWriters.has(cmd) && (flow.positions.some(([cwd]) => cwd === undefined)
			|| args.some(a => a === undefined || /(?:^|\\|::)(?:env|variable):/iu.test(a)));
}

const variableOptions = ["outvariable", "errorvariable", "warningvariable", "informationvariable", "pipelinevariable"];

// 公共参数可以把输出写入调用方变量。只读取参数节点，不把引号里的普通字符串当作选项。
export function outputVariables(words: PowerShellWord[], flow: Flow, env: Environment): Set<Scalar> {
	const names = new Set<Scalar>();
	for (const [i, word] of words.entries()) {
		const option = word.kind === "parameter" ? word.name : word;
		if (option.expression?.type !== "command_parameter") continue;
		const flag = option.source.slice(1).toLowerCase();
		if (!/^(?:ov|ev|wv|iv|pv)$/u.test(flag) && !(flag.includes("v") && variableOptions.some(name => name.startsWith(flag)))) continue;
		const operand = word.kind === "parameter" ? word.argument : words[i + 1];
		for (const name of operand ? wordValues(operand, flow, env) : []) names.add(name?.replace(/^\+/u, "").toLowerCase());
	}
	return names;
}

export function temporaryCommand(name: string, args: Scalar[], words: PowerShellWord[], { positions, env: assigned }: Flow, env: Environment): boolean {
	if (!args.every(a => a !== undefined)) return false;
	if (name === "git" || name === "git.exe") {
		const directories = temporaryGitDirectories(args);
		if (!directories || env.values.keys().some(k => gitScopeVariable.test(k)) || assigned.keys().some(k => gitScopeVariable.test(k))) return false;
		let dirs = positions.map(p => p[0]);
		for (const dest of directories) dirs = dirs.map(dir => filePath(dest, dir));
		return dirs.every(dir => dir !== undefined && isSystemTemporaryDescendant(dir));
	}
	if (name !== "remove-item") return false;
	const operands = args.filter((a, i) => words[i]?.expression?.type !== "command_parameter" || !/^-(?:force|recurse|path|literalpath)$/iu.test(a));
	return operands.length === 1 && operands.every(a => !a.startsWith("-") && positions.every(([cwd]) => {
		const dest = filePath(a, cwd);
		return dest !== undefined && isSystemTemporaryDescendant(dest);
	}));
}
