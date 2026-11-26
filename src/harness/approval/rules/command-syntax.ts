import { parseArgs } from "node:util";
import type { BashArg, BashArgv } from "../types.ts";

const apt = ["-o", "--option", "-c", "--config-file", "-t", "--target-release"];
const rpm = ["-c", "--config", "--installroot", "--releasever", "--setopt"];
const pip = ["--python", "--proxy", "--cache-dir", "--log"];
const packageOptions = new Map<string, readonly string[]>([
	["npm", ["--prefix", "--workspace", "-w"]], ["pnpm", ["--dir", "-C", "--filter", "-F"]],
	["yarn", ["--cwd"]], ["bun", ["--cwd"]], ["cargo", ["--config", "-C"]], ["go", ["-C"]],
	["apt", apt], ["apt-get", apt], ["dnf", rpm], ["yum", rpm], ["pip", pip], ["pip3", pip],
	["uv", ["--project", "--directory", "--config-file", "--cache-dir", "--color"]], ["brew", []], ["gem", []],
]);
const forwarding = new Set(["exec", "x", "dlx", "workspace", "workspaces", "global", "recursive"]);
const runForwarders = new Set(["bun", "uv", "yarn"]);

export function isSingleField(arg: BashArg | undefined): boolean {
	return typeof arg === "string" || arg?.singleField === true;
}

function packageFlag(program: string, word: string, index: number): boolean {
	switch (program) {
		case "cargo": return index === 1 && /^\+[\w.-]+$/u.test(word);
		case "apt": case "apt-get": case "dnf": case "yum": return word === "-y";
		case "pip": case "pip3": case "uv": return /^-(?:q+|v+)$/u.test(word);
		default: return false;
	}
}

function* packageStarts(argv: BashArgv, start: number, options: readonly string[]) {
	const program = argv[0];
	let i = start;
	while (i < argv.length) {
		const word = argv[i];
		if (typeof word !== "string") break;
		if (packageFlag(program, word, i)) { i++; continue; }
		const eq = word.indexOf("=");
		if (!options.includes(eq < 0 ? word : word.slice(0, eq))) break;
		if (eq < 0 && !isSingleField(argv[i + 1])) break;
		i += eq < 0 ? 2 : 1;
	}
	yield i;
	const verb = argv[i], script = argv[i + 1];
	const runMayForward = verb === "run" && runForwarders.has(program) && (typeof script !== "string" || script.startsWith("-") || packageOptions.has(script));
	if (typeof verb === "string" && !verb.startsWith("-") && !forwarding.has(verb) && !runMayForward) return;
	for (let j = i + 1; j < argv.length; j++) yield j;
}

const globalValues = new Map<string, readonly string[]>([
	["systemctl", ["-H", "-M", "--host", "--image", "--machine", "--root"]], ["launchctl", []],
	["git", ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]], ["gh", ["-R", "--repo"]],
	["docker", ["-c", "-H", "--context", "--host", "--config", "--log-level"]],
	["podman", ["-c", "--connection", "--url", "--identity", "--log-level"]],
]);
const gitFlags = new Set(["-p", "-P", "--paginate", "--no-pager", "--bare", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice",
	"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);

/** 未知全局选项可能取一个值。不能靠猜测的子命令命中例外。 */
function* globalStarts(argv: BashArgv, service: boolean): Generator<number> {
	const program = argv[0];
	const values = globalValues.get(program);
	if (!values) { yield 1; return; }
	let mayBeValue = false;
	for (let i = 1; i < argv.length; i++) {
		const word = argv[i];
		if (word === "--" && !service) { yield i + 1; return; }
		if (typeof word === "string" && word.startsWith("-")) {
			if (values.includes(word)) {
				const value = argv[++i];
				mayBeValue = typeof value === "object" && !value.singleField;
				if (mayBeValue) yield i;
			} else {
				const flag = program === "git" && gitFlags.has(word) || program === "podman" && word === "--remote";
				mayBeValue = !service && !flag && !word.includes("=");
			}
			continue;
		}
		yield i;
		if (typeof word === "string" && !mayBeValue) return;
		mayBeValue = typeof word !== "string";
	}
	yield argv.length;
}

const nestedPackages = new Set(["uv", "dnf", "yum", "brew"]);

export function interpretCommand(argv: BashArgv) {
	const program = argv[0];
	const options = packageOptions.get(program);
	const service = program === "systemctl" || program === "launchctl";
	return {
		argv, options: commandOptions(argv), service, packageManager: options !== undefined,
		starts: [...(options ? packageStarts(argv, 1, options) : globalStarts(argv, service))],
		nestedOptions: nestedPackages.has(program) ? options : undefined,
	};
}
export type CommandView = ReturnType<typeof interpretCommand>;

export function* nestedCommandStarts({ argv, nestedOptions }: CommandView, start: number) {
	const next = argv[start];
	if (nestedOptions && typeof next === "string" && next.startsWith("-")) yield* packageStarts(argv, start, nestedOptions);
}

function optionTokens(argv: BashArgv, start: number) {
	// 未解析的词也可能是选项，不能当作普通文件名确认例外。
	const args = argv.slice(start).map((word) => typeof word === "string" ? word : "--?");
	return parseArgs({ args, strict: false, tokens: true }).tokens.filter((t) => t.kind === "option");
}

const cleanFlags = new Set(["-d", "-f", "-i", "-n", "-q", "-x", "-X", "--dry-run", "--force"]);

/** 没有对应选项语法时，规则仍按连续参数匹配。 */
function commandOptions(argv: BashArgv) {
	switch (argv[0]) {
		case "curl": {
			const end = argv.indexOf("--", 1);
			return { kind: "prefix" as const, words: argv.slice(1, end < 0 ? undefined : end).filter((arg) => typeof arg === "string") };
		}
		case "wget": return { kind: "long" as const, names: optionTokens(argv, 1).map((t) => t.rawName) };
		case "rm": case "chmod": case "chown": return { kind: "unordered" as const, names: optionTokens(argv, 1).filter((t) => !t.inlineValue).map((t) => t.rawName) };
		case "pacman": return { kind: "clustered" as const, flags: optionTokens(argv, 1).filter((t) => /^-[A-Za-z]$/u.test(t.rawName)) };
	}
}

export function subcommandOptions(argv: BashArgv, pos: number) {
	if (argv[0] !== "git") return;
	const clean = argv[pos - 1] === "clean";
	const tokens = optionTokens(argv, pos);
	return {
		shortFlags: clean, definite: clean && tokens.every((t) => !t.inlineValue && cleanFlags.has(t.rawName)),
		names: tokens.filter((t) => !t.inlineValue).map((t) => t.rawName),
	};
}
