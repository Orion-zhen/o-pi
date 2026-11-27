import path from "node:path";
import type { ApprovalUnit } from "../../types.ts";
import type { PowerShellWord } from "../../../syntax-tree/powershell.ts";
import { filePath, IncompletePowerShellAnalysis } from "./locations.ts";
import { choices, variable, type Binding, type Flow, type Scalar } from "./flow.ts";
import { MAX_STRING_LENGTH } from "./interpolation.ts";

interface PathResult {
	output?: Binding;
	guidOperand?: { index: number; prefix: string };
	directories?: Extract<ApprovalUnit["target"], { kind: "path" }>[];
}

/** 仅处理普通文件系统路径，不调用提供程序，也不折叠路径段。 */
function joinedPath(words: PowerShellWord[], args: Scalar[]): string | undefined {
	const named = new Map<string, Scalar>(), positional: Scalar[] = [];
	for (let i = 0; i < words.length; i++) {
		const value = args[i];
		if (words[i]?.expression?.type !== "command_parameter") { positional.push(value); continue; }
		const key = value?.toLowerCase();
		if (!key || !["-path", "-childpath"].includes(key) || named.has(key) || !words[++i] || words[i]?.expression?.type === "command_parameter") return;
		named.set(key, args[i]);
	}
	const base = named.has("-path") ? named.get("-path") : positional.shift();
	const child = named.has("-childpath") ? named.get("-childpath") : positional.shift();
	const relative = /^[\w.][\w. -]*(?:[\\/][\w.][\w. -]*)*$/u;
	if (positional.length || !base || !child) return;
	if (base.length + child.length + 1 > MAX_STRING_LENGTH) throw new IncompletePowerShellAnalysis();
	const drivePath = /^[a-z]:[\\/]/iu.test(base) && (base.length === 3 || relative.test(base.slice(3))) && filePath(base, undefined);
	if ((relative.test(base) || drivePath) && relative.test(child)) return `${base.replace(/[\\/]$/u, "")}\\${child}`.replaceAll("/", "\\");
}

export function pathResult(name: string, words: PowerShellWord[], variants: Scalar[][], flow: Flow): PathResult | undefined {
	if (name === "join-path" && flow.positions.every(([cwd]) => cwd !== undefined)) {
		const paths = variants.map(args => joinedPath(words, args));
		if (paths.every(p => p !== undefined)) return { output: { type: "string", values: choices(paths) } };
		const child = words[1]?.expression;
		const prefix = child && /^\(\s*'([a-z_][\w-]*)'\s*\+\s*\[guid\]::NewGuid\(\)\.ToString\('N'\)\s*\)$/iu.exec(child.text)?.[1];
		if (prefix && words.length === 2 && variants.length === 1 && variants[0]) {
			const full = joinedPath(words, [variants[0][0], prefix]);
			if (full && /^[a-z]:\\/iu.test(full)) return { guidOperand: { index: 1, prefix }, output: { type: "string", values: [undefined], guidPrefix: full } };
		}
	}
	const option = (i: number, text: string) => words[i]?.expression?.type === "command_parameter" && words[i].value?.toLowerCase() === text;
	if (name !== "new-item" || !option(0, "-itemtype") || words[1]?.value?.toLowerCase() !== "directory") return;
	if (words.length !== 3 && !(words.length === 4 && option(2, "-path"))) return;
	const index = words.length - 1, operand = words[index];
	if (!operand || operand.expression?.type === "command_parameter") return;
	const key = variable(operand.source);
	const prefix = key?.scope === "local" && flow.locals.get(key.name)?.guidPrefix;
	if (prefix) {
		const guidPrefix = path.win32.normalize(prefix).replaceAll("\\", "/");
		return { guidOperand: { index, prefix }, directories: [{ kind: "path", guidPrefix, value: `${guidPrefix}<guid:N>` }] };
	}
	const paths = choices(variants.flatMap(args => flow.positions.map(([cwd]) => filePath(args[index], cwd))));
	if (paths.every(p => p !== undefined)) return { directories: paths.map(value => ({ kind: "path", value })) };
}
