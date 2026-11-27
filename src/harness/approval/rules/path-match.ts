import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import { ConfigError } from "../../config-loader.ts";
import type { ApprovalUnit, NumericFileName, PathGlob } from "../types.ts";

const globOptions = { dot: true, nonegate: true };

function isHostAbsolute(value: string): boolean {
	// Win32 的单根路径依赖当前盘符，不是独立的目录标识。
	return process.platform === "win32" ? /^(?:[a-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/iu.test(value) : path.isAbsolute(value);
}

// 仅展开首个完整路径段。变量的值不再参与变量展开或 glob 解析。
export function resolvePathGlobs(patterns: string[], use: "path" | "argument"): PathGlob[] {
	const result: PathGlob[] = [];
	for (const pattern of patterns) {
		const head = /^(?:%([\w()]+)%|\$\{((?:env:)?[A-Za-z_][\w()]*)\}|\$((?:env:)?[A-Za-z_]\w*))(?=[/\\]|$)/iu.exec(pattern);
		if (!head) {
			result.push({ pattern: use === "path" ? pattern.replaceAll("\\", "/") : pattern });
			continue;
		}
		const [, windows, braced, bare] = head;
		if (windows && process.platform !== "win32") continue;
		const name = windows ?? braced ?? bare;
		const value = !windows && name === "HOME" ? os.homedir() : name && process.env[name.replace(/^env:/iu, "")];
		if (!value || !isHostAbsolute(value)) throw new ConfigError(`Approval glob ${head[0]} requires an absolute host directory.`);
		const suffix = pattern.slice(head[0].length).replaceAll("\\", "/");
		result.push({ directory: path.resolve(value), pattern: suffix || "/" });
	}
	return result;
}

// 在目录内按 / 分隔的相对位置匹配后缀。目录本身对应 /。
function withinDirectory(directory: string, value: string): string | undefined {
	if (!isHostAbsolute(value)) return;
	const relative = path.relative(directory, value);
	if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return `/${relative.split(path.sep).join("/")}`;
}

export function matchPathGlob({ directory, pattern }: PathGlob): (value: string) => boolean {
	const matches = picomatch(pattern, globOptions);
	if (directory === undefined) return matches;
	return value => {
		const relative = withinDirectory(directory, value);
		return relative !== undefined && matches(relative);
	};
}

export function matchesGuidValue(prefix: string, value: string): boolean {
	return value.startsWith(prefix) && /^[0-9a-f]{32}$/iu.test(value.slice(prefix.length));
}

/** 最后 32 个十六进制字符未知。只排除确定不相交的模式，不用展示模板匹配规则。 */
export function mayMatchGuidGlob({ directory, pattern }: PathGlob, prefix: string): boolean {
	if (directory !== undefined) {
		if (!isHostAbsolute(prefix)) return false;
		const parent = withinDirectory(directory, path.dirname(prefix));
		if (parent === undefined) return matchesGuidValue(fold(path.resolve(prefix)), fold(directory)) && picomatch(pattern, globOptions)("/");
		prefix = `${parent === "/" ? "" : parent}/${path.basename(prefix)}`;
	}
	if (!/^[\w ./:*?-]+$/u.test(pattern)) return true;
	prefix = fold(prefix);
	pattern = pattern.replace(/^(?:\.\/)+/u, "");
	const literals = fold(pattern).split(/[*?]/u);
	const first = literals[0] ?? "", last = path.posix.basename(literals.at(-1) ?? "");
	if (literals.length === 1) return matchesGuidValue(prefix, first);
	return (first.startsWith(prefix) || prefix.startsWith(first)) && /^[0-9a-f]*$/iu.test(last.slice(-32)) && prefix.endsWith(last.slice(0, -32));
}

export function mayMatchWindowsPath({ directory, pattern }: PathGlob): boolean {
	if (directory !== undefined || pattern.startsWith("//") || /^[a-z]:\//iu.test(pattern)) return true;
	// 单根模式只检查 Bash 路径。未锚定的 glob 也可能匹配挂载点背后的宿主目录。
	return !pattern.startsWith("/") && !pattern.startsWith("skill://") && picomatch.scan(pattern).isGlob;
}

export function matchesTargetPath(target: ApprovalUnit["target"], patterns: PathGlob[]): boolean {
	if (target.kind !== "path") return false;
	const { value, directory: parent, numericName, guidPrefix } = target;
	if (guidPrefix !== undefined) return patterns.some(glob => mayMatchGuidGlob(glob, guidPrefix));
	return patterns.some(glob => {
		const { directory, pattern } = glob;
		if (parent === undefined) return matchPathGlob(glob)(directory === undefined ? value.replaceAll("\\", "/") : value);
		if (directory === undefined) return mayMatchChild(pattern, parent, numericName);
		const relative = withinDirectory(directory, parent);
		if (relative !== undefined) return pattern !== "/" && mayMatchChild(pattern, relative, numericName);
		// 文件名未知，但父目录已知。在变量目录外，唯一可能命中的子项是变量目录本身。
		return path.relative(directory, parent) === ".." && picomatch(pattern, globOptions)("/")
			&& (!numericName || matchesNumericName(path.basename(directory), numericName));
	});
}

const fold = (value: string) => path.sep === "\\" ? value.toLowerCase() : value;

function matchesNumericName(name: string, numeric: NumericFileName): boolean {
	const value = fold(name), prefix = fold(numeric.prefix), suffix = fold(numeric.suffix);
	return value.startsWith(prefix) && value.endsWith(suffix) && value.length >= prefix.length + suffix.length
		&& /^\d*$/u.test(value.slice(prefix.length, value.length - suffix.length));
}

function mayMatchNumericName(pattern: string, numeric: NumericFileName): boolean {
	const first = pattern.search(/[*?]/u);
	if (first < 0) return matchesNumericName(pattern, numeric);
	const prefix = fold(numeric.prefix), suffix = fold(numeric.suffix);
	const start = fold(pattern.slice(0, first));
	const end = fold(pattern.slice(Math.max(pattern.lastIndexOf("*"), pattern.lastIndexOf("?")) + 1));
	return (start.startsWith(prefix) || prefix.startsWith(start)) && (end.endsWith(suffix) || suffix.endsWith(end));
}

function mayMatchChild(glob: string, directory: string, numericName?: NumericFileName): boolean {
	if (numericName !== undefined && /^[\p{L}\p{M}\p{N}_ ./:*?-]+$/u.test(glob)) {
		if (!/[*?]/u.test(glob) && fold(path.dirname(glob)) !== fold(directory)) return false;
		if (!mayMatchNumericName(path.posix.basename(glob), numericName)) return false;
	}
	// 只在能证明父目录不相交时排除规则。复杂模式不拿展示用的文件名去匹配。
	if (!/^\/[\w./*?-]+$/u.test(glob)) return true;
	const parent = glob.slice(0, glob.lastIndexOf("/")) || "/";
	if (!glob.includes("**")) return picomatch(parent, globOptions)(directory);
	const prefix = glob.split(/[*?]/u, 1)[0] ?? "";
	const root = prefix.slice(0, prefix.lastIndexOf("/"));
	return directory === root || directory.startsWith(`${root}/`) || path.posix.dirname(root) === directory;
}
