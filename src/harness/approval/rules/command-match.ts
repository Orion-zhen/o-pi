import path from "node:path/posix";
import picomatch from "picomatch";
import { matchPathGlob, matchesGuidValue, mayMatchGuidGlob } from "./path-match.ts";
import { isSingleField, nestedCommandStarts, subcommandOptions, type CommandView } from "./command-syntax.ts";
import type { CommandRule, ShellArg } from "../types.ts";

const isOption = (word: string) => /^(?:-[A-Za-z]|--[\w-]+)$/u.test(word);
const isLongOption = (word: string) => /^--[\w-]+$/u.test(word);

function alternatives(word: string): string[] {
	return /^\{[^,{}]+(?:,[^,{}]+)+\}$/u.test(word) ? word.slice(1, -1).split(",") : [word];
}

function compilePrefix({ command: [program, ...words], exact, arg_globs }: CommandRule, nocase: boolean, exception = false) {
	const sc = process.platform === "win32" && alternatives(program).every((name) => /^sc(?:\.exe)?$/iu.test(name));
	const matchesProgram = picomatch(program, { dot: true, nonegate: true, nocase: nocase || sc });
	const glob = arg_globs?.map(matchPathGlob);
	const groups = words.map(alternatives);
	const [head, ...tail] = groups;
	const first = sc ? head?.map((word) => word.toLowerCase()) : head;
	const optionRule = !glob && !words.includes("*") && first?.every(isOption);
	const flags = !exact && !glob && tail.length === 1 && tail[0]?.every(isOption) ? tail[0] : undefined;
	const searchLong = !exception && first?.every((word) => !word.startsWith("-")) && flags?.every(isLongOption);

	function matchesArgs(view: CommandView, start: number, possible = false): boolean {
		const { argv, options } = view;
		function matchesWord(group: string[], arg: ShellArg | undefined): boolean {
			if (group.length === 1 && group[0] === "*") return exception ? isSingleField(arg) : arg !== undefined;
			if (typeof arg === "string") return group.includes(arg);
			if (exception || !arg) return false;
			if (possible && arg.unresolved) return true;
			const prefix = arg.guidPrefix;
			return prefix !== undefined && group.some(word => matchesGuidValue(prefix, word)) || arg.elements?.some(value => group.includes(value)) === true;
		}
		function unknownOption(from: number): boolean {
			if (!possible) return false;
			for (let i = from; i < argv.length; i++) {
				const arg = argv[i];
				if (arg === "--") break;
				if (typeof arg === "object" && arg.unresolved) return true;
			}
			return false;
		}
		function matchesTail(pos: number): boolean {
			const end = pos + tail.length;
			if (exact && end !== argv.length || !tail.every((group, i) => matchesWord(group, argv[pos + i]))) return false;
			return matchesOperands(argv.slice(end));
		}
		function matchesOperands(args: readonly ShellArg[]): boolean {
			return !glob || args.some((arg) => {
				if (possible && typeof arg !== "string" && arg.unresolved) return true;
				const text = typeof arg === "string" ? arg : arg.source.replace(/^["']|["']$/gu, "");
				if (typeof arg !== "string" && arg.elements?.some(value => glob.some(matches => matches(value) || matches(path.normalize(value.replaceAll("\\", "/")))))) return true;
				const prefix = typeof arg === "object" && arg.guidPrefix;
				if (prefix && arg_globs?.some(g => mayMatchGuidGlob(g, prefix) || mayMatchGuidGlob(g, path.normalize(prefix.replaceAll("\\", "/"))))) return true;
				const normalized = path.normalize(text.replaceAll("\\", "/"));
				return glob.some(matches => matches(text) || matches(normalized));
			});
		}
		// cmd 开关可以位于目标前后，路径模式只匹配非开关参数。
		if (view.argv[0].startsWith("cmd:") && glob && groups.length && groups.every(group => group.every(w => /^\/[a-z]+$/iu.test(w)))) {
			return groups.every(group => group.some(w => argv.includes(w.toLowerCase(), 1)))
				&& matchesOperands(argv.slice(1).filter(arg => typeof arg !== "string" || !/^\/[a-z]+$/iu.test(arg)));
		}
		if (!first) return exact && view.packageManager ? start === argv.length : matchesTail(1);

		if (!exception && !exact && options) {
			if (options.kind === "clustered" && options.flags.some((t) => first.includes(t.rawName) && matchesTail(t.index + 2))) return true;
			if (optionRule) {
				if (options.kind === "prefix" && !tail.length) return unknownOption(1) || options.words.some((arg) => first.some((name) => arg.startsWith(name)));
				if (options.kind === "long" && !tail.length && first.every(isLongOption)) return unknownOption(1) || options.names.some((name) => first.includes(name));
				if (options.kind === "unordered") return groups.every((group) => group.every(isOption)
					? unknownOption(1) || group.some((name) => options.names.includes(name)) : possible || group.some((word) => argv.includes(word, 1)));
			}
		}
		const at = (pos: number) => {
			const arg = argv[pos];
			if (!matchesWord(first, sc && typeof arg === "string" ? arg.toLowerCase() : arg)) return false;
			const next = pos + 1;
			if (flags) {
				const options = subcommandOptions(argv, next);
				if (options && (options.shortFlags || searchLong)) return (!exception || options.definite) && (unknownOption(next) || options.names.some((name) => flags.includes(name)));
			}
			if (matchesTail(next)) return true;
			return !exception && tail.length > 0 && nestedCommandStarts(view, next).some(matchesTail);
		};
		if (at(start)) return true;
		if (start === 1 || view.service && !first.some((word) => word.startsWith("-"))) return false;
		return at(1);
	}
	return { matchesProgram, matchesArgs };
}

export type Match = "definite" | "possible" | "none";

export function matchCommand(rule: CommandRule, nocase: boolean): (views: CommandView[]) => Match {
	const main = compilePrefix(rule, nocase);
	const exclusions = rule.except?.map(command => compilePrefix({ command }, nocase, true)) ?? [];
	return views => {
		let result: Match = "none";
		for (const view of views) {
			const program = view.argv[0];
			if (!main.matchesProgram(program)) continue;
			for (const start of view.starts) {
				if (exclusions.some(prefix => prefix.matchesProgram(program) && prefix.matchesArgs(view, start))) continue;
				if (main.matchesArgs(view, start)) return "definite";
				if (result === "none" && view.hasUnresolved && main.matchesArgs(view, start, true)) result = "possible";
			}
		}
		return result;
	};
}
