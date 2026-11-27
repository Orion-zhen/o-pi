import path from "node:path";
import { normalizeTargetPath } from "../path.ts";

export class IncompletePowerShellAnalysis extends Error {}
export const CHOICE_LIMIT = 16;

/** 栈顶是当前位置，后续元素是 Push-Location 保存的位置。 */
export type Location = readonly [string | undefined, ...(string | undefined)[]];
export function locations(items: Location[]): Location[] {
	const unique = new Map(items.map(item => [JSON.stringify(item), item]));
	if (unique.size > CHOICE_LIMIT) throw new IncompletePowerShellAnalysis();
	return Array.from(unique.values());
}

export function filePath(value: string | undefined, cwd: string | undefined, literal = false): string | undefined {
	if (!value || /[\x00-\x1f*?`]/u.test(value) || !literal && /[[\]]/u.test(value) || /^~|^[/\\]{2}[?.][/\\]/u.test(value)) return;
	if (/^[/\\](?![/\\])/u.test(value)) {
		if (!cwd || !/^[a-z]:[/\\]/iu.test(cwd)) return;
		value = cwd.slice(0, 2) + value;
	}
	// Win32 会规范化段末的空格和点，不能按普通字面路径证明边界。
	if (value.split(/[/\\]/u).some(part => part !== "." && part !== ".." && /[ .]$/u.test(part))) return;
	if (value.includes(":") && !/^[a-z]:[/\\][^:]*$/iu.test(value)) return;
	if (path.win32.isAbsolute(value)) return path.win32.normalize(value).replaceAll("\\", "/");
	if (cwd !== undefined) return /^[a-z]:\/|^\/\//iu.test(cwd) ? path.win32.resolve(cwd, value).replaceAll("\\", "/") : normalizeTargetPath(value.replaceAll("\\", "/"), cwd);
}

const locationCommands = new Set(["set-location", "sl", "cd", "chdir", "push-location", "pushd", "pop-location", "popd"]);
export function locationChange(program: string, args: readonly (string | undefined)[], before: Location[]): Location[] | undefined {
	program = program.slice(program.lastIndexOf("\\") + 1);
	if (!locationCommands.has(program)) return;
	if (program === "pop-location" || program === "popd") {
		if (args.length) return locations([...before, [undefined]]);
		return locations(before.map(position => {
			const [, top, ...rest] = position;
			return position.length > 1 ? [top, ...rest] : position;
		}));
	}
	const push = program === "push-location" || program === "pushd";
	const arg = args.length === 1 && !args[0]?.startsWith("-") ? args[0] : args.length === 2 && /^-(?:literal)?path$/iu.test(args[0] ?? "") ? args[1] : undefined;
	if (arg === undefined || arg === "+" || arg === "-") return locations([...before, [undefined]]);
	// 切换失败也可能继续执行。成功分支与失败分支分别保存自己的栈。
	return locations([...before, ...before.map((position): Location => {
		if (push && position.length >= CHOICE_LIMIT) throw new IncompletePowerShellAnalysis();
		return [filePath(arg, position[0], args.length === 2 && args[0]?.toLowerCase() === "-literalpath"), ...(push ? position : position.slice(1))];
	})]);
}
