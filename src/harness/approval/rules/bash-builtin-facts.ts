import type { BashArg, BashArgv, BashPipeline } from "../types.ts";

type AnalyzedFact = "credential.read" | "network.external-write" | "package.change" | "filesystem.destructive"
	| "system.catastrophic" | "service.change" | "infrastructure.change" | "execution.remote-script";
type Args = readonly BashArg[];

function options(args: Args): Args {
	const end = args.indexOf("--");
	return end < 0 ? args : args.slice(0, end);
}

function shortFlag(opts: Args, flags: string): boolean {
	return opts.some((arg) => typeof arg === "string" && arg.startsWith("-") && !arg.startsWith("--") && [...flags].some((flag) => arg.slice(1).includes(flag)));
}

const systemctlRead = new Set("cat get-default get-property help is-active is-enabled is-failed list-dependencies list-jobs list-machines list-sockets list-timers list-unit-files list-units show show-environment status".split(" "));
const launchctlRead = new Set("blame error getenv help hostinfo list managername managerpid manageruid print print-cache procinfo".split(" "));
const systemctlValues = new Set(["-H", "-M", "--host", "--image", "--machine", "--root"]);
function serviceChange(program: "systemctl" | "launchctl" | "service", args: Args): boolean {
	if (program === "service") return args.length >= 2 && args[1] !== "status";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (typeof arg !== "string") return true;
		if (program === "systemctl" && systemctlValues.has(arg)) { i++; continue; }
		if (!arg.startsWith("-")) return !(program === "systemctl" ? systemctlRead : launchctlRead).has(arg);
	}
	return false;
}

const release = new Set(["create", "delete", "edit", "upload"]);
const dockerRead = new Set(["inspect", "ps", "logs", "images", "history", "info", "stats", "top", "version"]);
const optionsWithValue = {
	git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"],
	gh: ["-R", "--repo"],
	docker: ["-c", "-H", "--context", "--host", "--config", "--log-level"],
};
const gitFlagsWithoutValue = new Set([
	"-p", "-P", "--paginate", "--no-pager", "--bare", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice",
	"--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
]);
type SubcommandProgram = keyof typeof optionsWithValue;

/** 未知全局选项可能取一个值，因此保留两种子命令位置。 */
function* subcommandIndices(program: SubcommandProgram, args: Args) {
	let mayBeValue = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "--") {
			if (i + 1 < args.length) yield i + 1;
			return;
		}
		if (typeof word !== "string") { yield i; mayBeValue = true; continue; }
		if (optionsWithValue[program].includes(word)) { i++; mayBeValue = false; continue; }
		if (word.startsWith("-")) {
			mayBeValue = !word.includes("=") && !(program === "git" && gitFlagsWithoutValue.has(word));
			continue;
		}
		yield i;
		if (!mayBeValue) return;
		mayBeValue = false;
	}
}

function subcommandFacts(program: SubcommandProgram, args: Args): AnalyzedFact[] {
	const facts: AnalyzedFact[] = [];
	const lastRemoval = program === "docker" ? Math.max(args.lastIndexOf("rm"), args.lastIndexOf("prune")) : -1;
	for (const i of subcommandIndices(program, args)) {
		const verb = args[i];
		if (program === "gh") {
			const action = args[i + 1];
			if (verb === "release" && typeof action === "string" && release.has(action)) facts.push("network.external-write");
			continue;
		}
		if (verb === "push" || program === "docker" && verb === "image" && args[i + 1] === "push") {
			facts.push("network.external-write");
			continue;
		}
		if (program === "git") {
			if (verb !== "clean" && verb !== "reset") continue;
			const opts = options(args.slice(i + 1));
			if (verb === "clean" && shortFlag(opts, "f") || verb === "reset" && opts.includes("--hard")) facts.push("filesystem.destructive");
			continue;
		}
		if (typeof verb === "string" && dockerRead.has(verb)) continue;
		if (verb === "system" && args[i + 1] === "prune") facts.push("filesystem.destructive");
		// 插件和命令组仍可能在后续参数中调用 rm 或 prune。
		if (lastRemoval >= i) facts.push("infrastructure.change");
	}
	return facts;
}

export function builtinCommandFacts([program, ...args]: BashArgv): AnalyzedFact[] {
	if (program === "git" || program === "docker" || program === "gh") return subcommandFacts(program, args);
	if (program === "systemctl" || program === "launchctl" || program === "service") return serviceChange(program, args) ? ["service.change"] : [];
	if (process.platform === "win32" && /^powershell(?:\.exe)?$/iu.test(program)) {
		return args.some((arg) => typeof arg === "string" && /\b(?:Start|Stop|Restart)-Service\b/iu.test(arg)) ? ["service.change"] : [];
	}
	const opts = options(args);
	switch (program) {
		case "rm":
			if (!shortFlag(opts, "rR") && !opts.includes("--recursive")) return [];
			if (!shortFlag(opts, "f") && !opts.includes("--force")) return [];
			return args.includes("/") ? ["filesystem.destructive", "system.catastrophic"] : ["filesystem.destructive"];
		case "chmod":
		case "chown":
			if (!args.includes("/") || program === "chmod" && !args.includes("777")) return [];
			return shortFlag(opts, "R") || opts.includes("--recursive") ? ["system.catastrophic"] : [];
		case "curl": {
			const upload = ["--data", "--form", "--upload-file", "-F", "-T", "-d"];
			return opts.some((arg) => typeof arg === "string" && upload.some((flag) => arg.startsWith(flag))) ? ["network.external-write"] : [];
		}
		case "wget": return opts.some((arg) => typeof arg === "string" && /^(?:--post-data|--post-file|--method)(?:=|$)/u.test(arg)) ? ["network.external-write"] : [];
		case "rsync": return args.some((arg) => typeof arg === "string" && arg.includes(":")) ? ["network.external-write"] : [];
		case "pacman": return shortFlag(opts, "SRU") ? ["package.change"] : [];
		default: return [];
	}
}

/** 对同一管道按阶段顺序检查，允许下载或查找结果经过中间过滤命令。 */
export function builtinPipelineFacts({ stages }: BashPipeline): AnalyzedFact[] {
	let firstDownload = -1, dotenv = false;
	const facts = new Set<AnalyzedFact>();
	for (const [i, stage] of stages.entries()) {
		if (firstDownload >= 0 && i > firstDownload + 1 && stage.some(([name]) => name === "sh" || name === "bash" || name === "zsh" || name === "fish")) facts.add("execution.remote-script");
		if (dotenv && stage.some(([name, command]) => name === "xargs" && command === "cat")) facts.add("credential.read");
		if (firstDownload < 0 && stage.some(([name]) => name === "curl" || name === "wget")) firstDownload = i;
		dotenv ||= stage.some(([name, ...args]) => name === "find" && args.some((arg) => typeof arg === "string" && arg.includes(".env")));
	}
	return [...facts];
}
