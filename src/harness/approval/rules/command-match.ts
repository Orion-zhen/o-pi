import path from "node:path/posix";
import picomatch from "picomatch";
import { isSingleField, nestedCommandStarts, subcommandOptions, type CommandView } from "./command-syntax.ts";
import type { BashArg, BashMatcher } from "../types.ts";

type Prefix = Extract<BashMatcher, { command: unknown }>;
const isOption = (word: string) => /^(?:-[A-Za-z]|--[\w-]+)$/u.test(word);
const isLongOption = (word: string) => /^--[\w-]+$/u.test(word);

function alternatives(word: string): string[] {
	return /^\{[^,{}]+(?:,[^,{}]+)+\}$/u.test(word) ? word.slice(1, -1).split(",") : [word];
}

function compilePrefix({ command: [program, ...words], exact, arg_globs }: Prefix, mode: "rule" | "exception") {
	const sc = process.platform === "win32" && alternatives(program).every((name) => /^sc(?:\.exe)?$/iu.test(name));
	const matchesProgram = picomatch(program, { dot: true, nonegate: true, nocase: sc });
	const glob = arg_globs && picomatch(arg_globs, { dot: true, nonegate: true });
	const groups = words.map(alternatives);
	const [head, ...tail] = groups;
	const first = sc ? head?.map((word) => word.toLowerCase()) : head;
	const optionRule = !glob && !words.includes("*") && first?.every(isOption);
	const flags = !exact && !glob && tail.length === 1 && tail[0]?.every(isOption) ? tail[0] : undefined;
	const searchLong = mode === "rule" && first?.every((word) => !word.startsWith("-")) && flags?.every(isLongOption);

	function matchesWord(group: string[], arg: BashArg | undefined): boolean {
		if (group.length === 1 && group[0] === "*") return mode === "exception" ? isSingleField(arg) : arg !== undefined;
		return typeof arg === "string" && group.includes(arg);
	}
	function matchesArgs(view: CommandView, start: number): boolean {
		const { argv, options } = view;
		function matchesTail(pos: number): boolean {
			const end = pos + tail.length;
			if (exact && end !== argv.length || !tail.every((group, i) => matchesWord(group, argv[pos + i]))) return false;
			return !glob || argv.slice(end).some((arg) => {
				const text = typeof arg === "string" ? arg : arg.source.replace(/^["']|["']$/gu, "");
				return glob(text) || glob(path.normalize(text.replaceAll("\\", "/")));
			});
		}
		if (!first) return exact && view.packageManager ? start === argv.length : matchesTail(1);

		if (mode === "rule" && !exact && options) {
			if (options.kind === "clustered" && options.flags.some((t) => first.includes(t.rawName) && matchesTail(t.index + 2))) return true;
			if (optionRule) {
				if (options.kind === "prefix" && !tail.length) return options.words.some((arg) => first.some((name) => arg.startsWith(name)));
				if (options.kind === "long" && !tail.length && first.every(isLongOption)) return options.names.some((name) => first.includes(name));
				if (options.kind === "unordered") return groups.every((group) => group.every(isOption)
					? group.some((name) => options.names.includes(name)) : group.some((word) => argv.includes(word, 1)));
			}
		}
		const at = (pos: number) => {
			const arg = argv[pos];
			if (!matchesWord(first, sc && typeof arg === "string" ? arg.toLowerCase() : arg)) return false;
			const next = pos + 1;
			if (flags) {
				const options = subcommandOptions(argv, next);
				if (options && (options.shortFlags || searchLong)) return (mode === "rule" || options.definite) && options.names.some((name) => flags.includes(name));
			}
			if (matchesTail(next)) return true;
			return mode === "rule" && tail.length > 0 && nestedCommandStarts(view, next).some(matchesTail);
		};
		if (at(start)) return true;
		if (start === 1 || view.service && !first.some((word) => word.startsWith("-"))) return false;
		return at(1);
	}
	return { matchesProgram, matchesArgs };
}

export function matchCommand(rule: Prefix): (view: CommandView) => boolean {
	const main = compilePrefix(rule, "rule");
	const exclusions = rule.except?.map((command) => compilePrefix({ command }, "exception")) ?? [];
	return (view) => {
		if (!main.matchesProgram(view.argv[0])) return false;
		const except = exclusions.filter((prefix) => prefix.matchesProgram(view.argv[0]));
		return view.starts.some((start) => main.matchesArgs(view, start) && !except.some((prefix) => prefix.matchesArgs(view, start)));
	};
}
