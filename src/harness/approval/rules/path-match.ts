import path from "node:path";
import picomatch from "picomatch";
import type { ApprovalUnit, NumericFileName } from "../types.ts";

export function matchesTargetPath(target: ApprovalUnit["target"], patterns: string[]): boolean {
	if (target.kind !== "path") return false;
	return patterns.some((pattern) => {
		const glob = pattern.replace(/\\/g, "/");
		if (target.directory === undefined) return picomatch(glob, { dot: true, nonegate: true })(target.value.replace(/\\/g, "/"));
		return mayMatchChild(glob, target.directory, target.numericName);
	});
}

function mayMatchNumericName(pattern: string, { prefix, suffix }: NumericFileName): boolean {
	const first = pattern.search(/[*?]/u);
	if (first < 0) {
		return pattern.startsWith(prefix) && pattern.endsWith(suffix) && pattern.length >= prefix.length + suffix.length
			&& /^\d*$/u.test(pattern.slice(prefix.length, pattern.length - suffix.length));
	}
	const start = pattern.slice(0, first);
	const end = pattern.slice(Math.max(pattern.lastIndexOf("*"), pattern.lastIndexOf("?")) + 1);
	return (start.startsWith(prefix) || prefix.startsWith(start)) && (end.endsWith(suffix) || suffix.endsWith(end));
}

function mayMatchChild(glob: string, directory: string, numericName?: NumericFileName): boolean {
	if (numericName !== undefined && /^[\p{L}\p{M}\p{N}_ ./:*?-]+$/u.test(glob)) {
		const fold = (value: string) => path.sep === "\\" ? value.toLowerCase() : value;
		if (!/[*?]/u.test(glob) && fold(path.dirname(glob)) !== fold(directory)) return false;
		if (!mayMatchNumericName(fold(path.posix.basename(glob)), { prefix: fold(numericName.prefix), suffix: fold(numericName.suffix) })) return false;
	}
	// 只在能证明父目录不相交时排除规则。复杂模式不拿展示用的文件名去匹配。
	if (!/^\/[\w./*?-]+$/u.test(glob)) return true;
	const parent = glob.slice(0, glob.lastIndexOf("/")) || "/";
	if (!glob.includes("**")) return picomatch(parent, { dot: true, nonegate: true })(directory);
	const prefix = glob.split(/[*?]/u, 1)[0] ?? "";
	const root = prefix.slice(0, prefix.lastIndexOf("/"));
	return directory === root || directory.startsWith(`${root}/`) || path.posix.dirname(root) === directory;
}
