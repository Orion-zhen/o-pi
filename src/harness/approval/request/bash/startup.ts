import { walkNamedNodes } from "./syntax.ts";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import { UNSET, type BashAnalysisContext } from "./state.ts";

export interface StartupFacts {
	env: Readonly<NodeJS.ProcessEnv>;
	used: Map<string, string | null>;
}

export function hasStartupHooks(env: Readonly<NodeJS.ProcessEnv>): boolean {
	return Boolean(env.BASH_ENV || env.ENV || env.BASHOPTS || env.SHELLOPTS || Object.keys(env).some((key) => key.startsWith("BASH_FUNC_")));
}

// 这些变量可能由 Shell 创建、改写或随执行进度变化，不是普通继承变量。
const managed = /^(?:_|BASH.*|SHLVL|IFS|(?:OLD)?PWD|(?:E?UID|PPID)|S?RANDOM|SECONDS|EPOCH.*|LINENO|FUNCNAME|GROUPS|DIRSTACK|PIPESTATUS|SHELLOPTS|OPT(?:IND|ARG|ERR)|REPLY|MAPFILE|HISTCMD|HOST(?:NAME|TYPE)|MACHTYPE|OSTYPE|SHELL|TERM|PS[0-4]|COMP_.*|COPROC)$/u;

export function isOrdinaryVariable(name: string): boolean {
	return /^[a-zA-Z_][a-zA-Z_0-9]*$/u.test(name) && !managed.test(name);
}

export function seedStartupVariables(root: SyntaxNode, check: () => void, variables: BashAnalysisContext["variables"], env: Readonly<NodeJS.ProcessEnv>): void {
	const names = new Set(["CDPATH", "HOME"]);
	const modifiedInExpansion = new Set<string>();
	for (const node of walkNamedNodes(root, check)) {
		if (node.type !== "variable_name") continue;
		names.add(node.text);
		// 参数赋值和算术表达式可以在展开期间改写变量，不能沿用启动值。
		const parent = node.parent;
		if (parent?.type.endsWith("_expression") || parent?.type === "expansion" && parent.children.some((part) => part.type === "=" || part.type === ":=")) {
			modifiedInExpansion.add(node.text);
		}
	}
	for (const name of names) {
		if (!isOrdinaryVariable(name) || modifiedInExpansion.has(name)) continue;
		const value = Object.hasOwn(env, name) ? env[name] : undefined;
		if (value === undefined && name === "PATH") continue;
		variables.set(name, { startup: value === undefined ? UNSET : { value, temporary: false } });
	}
}
