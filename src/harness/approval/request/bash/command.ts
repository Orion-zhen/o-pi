import path from "node:path";
import type { SyntaxNode } from "../../../syntax-tree/types.ts";
import type { ApprovalUnit, ShellArg, ShellArgv } from "../../types.ts";
import { IncompleteBashAnalysis, UNKNOWN_DIRECTORY, UNSET, readVariable, joinDirectories,
	type Directories, type BashAnalysisContext, type ResolvedShellValue } from "./branches.ts";
import {
	MAX_EXPANDED_FIELDS,
	TEMPORARY_DIRECTORY_PATH,
	TEMPORARY_FILE_PATH,
	absoluteHome,
	displayTemporaryPath,
	isSyntheticTemporaryPath,
	resolvePath,
	resolvePathCandidates,
	resolveShellToken,
	positionalValues,
	shellArgumentValue,
	singleValue,
} from "./state.ts";
import { temporaryGitDirectories } from "../../rules/command-syntax.ts";
import { singleField } from "./simple-expansion.ts";
import { NUMERIC_FIELD, commandWords, normalizeCommandNode, normalizeSource, shellWordSource } from "./syntax.ts";

const SHELL_PROGRAMS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u",
	"--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user",
]);

export interface CommandFacts {
	program: string | undefined;
	args: ShellArg[];
}

interface NestedShell {
	bash: boolean;
	script: string;
	args: ShellArg[];
}

interface ParsedCommand {
	unit: ApprovalUnit & { commands: ShellArgv[] };
	checkWithoutVariables: boolean;
	concreteExecution: boolean;
	invoked: CommandFacts;
	fields: ShellArg[];
	nestedShell: NestedShell | undefined;
	cdTarget: Directories | undefined;
}

function successfulCdTarget(raw: CommandFacts, context: BashAnalysisContext, exactWords: boolean, directCd: boolean): Directories | undefined {
	if (raw.program !== "cd" && raw.program !== "command" && raw.program !== "builtin") return undefined;
	const facts = raw.program === "cd" ? raw : unwrapCommand(raw);
	if (facts.program !== "cd") return undefined;
	const unknown = [UNKNOWN_DIRECTORY];
	if (!exactWords) return unknown;
	let destination: ResolvedShellValue | undefined;
	let options = true;
	for (const value of facts.args) {
		if (typeof value !== "string") return unknown;
		if (options && value === "--") { options = false; continue; }
		if (options && value === "-L") continue;
		if ((options && value.startsWith("-") || value === "-") || destination !== undefined) return unknown;
		options = false;
		destination = { value, temporary: isSyntheticTemporaryPath(value) };
	}
	if (destination === undefined) {
		const home = directCd && facts.args.length === 0 ? absoluteHome(context) : undefined;
		if (home === undefined) return unknown;
		destination = shellArgumentValue(home);
	}
	const target = destination;
	// 裸目录名还可能通过 CDPATH 查找，不能只枚举 cwd 下的路径。
	const directories = context.cwd.map((cwd) => resolvePath(target, cwd) ?? UNKNOWN_DIRECTORY);
	if (!target.temporary && !path.isAbsolute(target.value) && !/^\.{1,2}(?:\/|$)/u.test(target.value)) {
		const search = readVariable("CDPATH", context);
		const choices: readonly (ResolvedShellValue | typeof UNSET | undefined)[] = search !== undefined && search !== UNSET && "choices" in search ? search.choices : [search];
		for (const value of choices) {
			if (value === UNSET) continue;
			if (value === undefined || value.value.includes("\0") || process.platform === "win32" && value.value !== "") {
				directories.push(UNKNOWN_DIRECTORY);
				continue;
			}
			for (const prefix of value.value.split(":")) {
				if (!prefix) continue;
				const candidate = shellArgumentValue(`${prefix}/${target.value}`);
				for (const cwd of context.cwd) directories.push(resolvePath(candidate, cwd) ?? UNKNOWN_DIRECTORY);
			}
		}
	}
	return joinDirectories(directories);
}

export function temporaryPathAssignment(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type === "string") {
		const child = singleValue(node.namedChildren);
		return child?.type === "command_substitution" && node.text === `"${child.text}"`
			? temporaryPathAssignment(child, context)
			: undefined;
	}
	if (node.type !== "command_substitution" || context.functionNames.has("mktemp")) return undefined;
	const command = singleValue(node.namedChildren);
	if (command?.type !== "command") return undefined;
	const facts = unwrapCommand(commandFacts(command, context));
	if (facts.program !== "mktemp" || !facts.args.every((arg) => typeof arg === "string")) return undefined;
	const directory = mktempDirectoryMode(facts.args);
	if (directory === undefined) return undefined;
	const fileDirectory = directory ? undefined : absoluteTemplateDirectory(command);
	return {
		...(fileDirectory === undefined ? {} : { fileDirectory }),
		value: directory ? TEMPORARY_DIRECTORY_PATH : TEMPORARY_FILE_PATH,
		temporary: true,
	};
}

function absoluteTemplateDirectory(command: SyntaxNode): string | undefined {
	if (process.platform === "win32" || command.namedChildren.length !== 2) return undefined;
	const [program, argument] = commandWords(command);
	const template = argument?.literal;
	if (program?.literal !== "mktemp" || template === undefined || !path.isAbsolute(template)
		|| /[\\\0*?[{}]/u.test(template) || template.split("/").includes("..")) return undefined;
	return path.resolve(path.dirname(template));
}

function mktempDirectoryMode(args: readonly string[]): boolean | undefined {
	let directory = false;
	let positional = 0;
	let optionsEnded = false;
	let skipNext = false;
	for (const [index, argument] of args.entries()) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (optionsEnded || !argument.startsWith("-") || argument === "-") {
			positional += 1;
			if (positional > 1) return undefined;
			continue;
		}
		if (argument === "--") {
			optionsEnded = true;
			continue;
		}
		if (argument === "--directory") {
			directory = true;
			continue;
		}
		if (argument === "--quiet" || argument === "--tmpdir" || argument.startsWith("--tmpdir=")) continue;
		if (argument === "--dry-run") return undefined;
		if (argument.startsWith("--suffix=")) continue;
		if (argument === "--suffix") {
			if (index + 1 >= args.length) return undefined;
			skipNext = true;
			continue;
		}
		if (argument.startsWith("--")) return undefined;
		const options = argument.slice(1);
		for (const [optionIndex, option] of [...options].entries()) {
			if (option === "d") directory = true;
			else if (option === "q") continue;
			else if (option === "u" || option === "t") return undefined;
			else if (option === "p") {
				if (optionIndex + 1 < options.length) break;
				if (index + 1 >= args.length) return undefined;
				skipNext = true;
				break;
			} else return undefined;
		}
	}
	return directory;
}

export function commandUnit(node: SyntaxNode, context: BashAnalysisContext, invocation: BashAnalysisContext): ParsedCommand {
	const { facts: rawFacts, invoked, globVariant, contextResolved, exactWords, fields } = resolveCommand(node, context);
	const facts = unwrapCommand(rawFacts);
	const effective = effectiveCommand(facts);
	const shell = shellInvocation(effective);
	const nestedShell = shell && shell !== "dynamic" ? { script: shell.script, bash: effective.program === "bash",
		args: fields.slice(fields.length - effective.args.length + shell.argsStart) } : undefined;
	const unit = executionUnit(node, [rawFacts, facts, effective], !contextResolved, shell === "dynamic", globVariant);
	if (commandEffectsStayTemporary(facts, invocation, rawFacts === facts)) unit.effect_scope = "temporary";
	return {
		unit,
		checkWithoutVariables: contextResolved && shell !== "dynamic",
		concreteExecution: exactWords && effective === rawFacts && effective.program !== undefined
			&& effective.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
			&& (!SHELL_PROGRAMS.has(effective.program) || nestedShell !== undefined),
		invoked,
		fields,
		nestedShell,
		cdTarget: successfulCdTarget(invoked, invocation, exactWords, node.childForFieldName("name")?.text === "cd"),
	};
}

export function dynamicCommandUnit(node: SyntaxNode, context: BashAnalysisContext): ApprovalUnit | undefined {
	const { facts: raw, globVariant } = resolveCommand(node, context);
	const facts = unwrapCommand(raw);
	const effective = effectiveCommand(facts);
	if (shellInvocation(effective) !== "dynamic") return undefined;
	return executionUnit(node, [raw, facts, effective], false, true, globVariant);
}

function executionUnit(
	node: SyntaxNode, views: CommandFacts[], remember: boolean, opaque: boolean, globVariant: CommandFacts | undefined,
): ParsedCommand["unit"] {
	if (globVariant) {
		const unwrapped = unwrapCommand(globVariant);
		views.push(globVariant, unwrapped, effectiveCommand(unwrapped));
	}
	const commands: ShellArgv[] = [];
	for (const { program, args } of new Set(views)) {
		if (program !== undefined) commands.push([program, ...args]);
	}
	return {
		action: "execute",
		target: { kind: "command", value: normalizeCommandNode(node) },
		commands,
		...(opaque && { analysisFact: "shell.run-opaque-input" }),
		remember,
	};
}

export function commandFacts(node: SyntaxNode, context: BashAnalysisContext): CommandFacts {
	return resolveCommand(node, context).facts;
}

function resolveCommand(node: SyntaxNode, context: BashAnalysisContext) {
	let contextResolved = false;
	let expandedFields = 0;
	const words = commandWords(node).flatMap(word => {
		if (word.source !== '"$@"' && word.source !== '"${@}"') return [word];
		const args = positionalValues(context);
		if (!args) return [word];
		contextResolved = true;
		expandedFields += args.length;
		if (expandedFields > MAX_EXPANDED_FIELDS) throw new IncompleteBashAnalysis();
		return args.map(literal => ({ ...word, literal }));
	});
	let exactWords = true;
	const values = words.map((word, index) => {
		if (word.literal !== undefined) return { value: word.literal, field: word.literal };
		const resolve = (allowGlob: boolean) => word.source === word.node.text
			? resolveShellWord(word.node, context, false, allowGlob)
			: resolveShellToken(word.source, context, false, allowGlob);
		const exact = resolve(false);
		if (exact === undefined) exactWords = false;
		const resolved = exact ?? (index > 0 ? resolve(true) : undefined);
		if (resolved !== undefined) contextResolved = true;
		if (!resolved || resolved.value.includes(NUMERIC_FIELD) || (resolved.fileDirectory !== undefined && !resolved.temporary)) {
			// 简单双引号标量即使值未知也只占一个参数；"$@" 和裸展开没有这个保证。
			const scalar = /^"\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})"$/u.test(word.source);
			const field = { source: word.source };
			return { value: scalar ? { ...field, singleField: true as const } : field, field };
		}
		const singleField = word.source === word.node.text && !resolved.value.includes("\0") && (
			word.node.type === "string" || word.node.type === "ansi_c_string" || (word.node.type === "word" && word.source.startsWith("~")) || context.simpleSites?.has(word.node.id) === true
		);
		return { value: resolved.value, field: singleField ? resolved.value : { source: word.source }, glob: exact === undefined ? { source: word.source } : undefined };
	});
	const [program, ...args] = values.map((word) => word.value);
	const fields = values.slice(1).map(word => word.field);
	const facts = { program: commandBasename(program), args };
	// 模式文本可用于触发规则，但文件名展开可能改变参数数量，不能仅凭文本命中例外。
	const globVariant = values.some((word) => word.glob !== undefined)
		? { ...facts, args: values.slice(1).map((word) => word.glob ?? word.value) } : undefined;
	return { facts, invoked: { program: typeof program === "string" ? program : undefined, args }, globVariant, contextResolved, exactWords, fields };
}

export function redirectUnits(node: SyntaxNode, context: BashAnalysisContext): ApprovalUnit[] {
	const operator = node.children.find((child) => !child.isNamed)?.text;
	if (operator === undefined || !writesFile(operator, node)) return [];
	const destination = node.childForFieldName("destination");
	if (destination === null) return [dynamicRedirectUnit(node)];
	if (destination.type === "process_substitution") return [];
	const resolved = resolveShellWord(destination, context, false, true);
	if (resolved === undefined || resolved.value === "") return [dynamicRedirectUnit(node)];
	if (operator === ">&" && (resolved.value === "-" || /^\d+$/u.test(resolved.value))) return [];
	if (path.sep === "\\" && resolved.value.startsWith("/") && !resolved.value.startsWith("//") && !resolved.value.includes("\\")) {
		// 未展开的文件名模式和数字占位符不能作为精确路径匹配。
		if (resolved.value.includes("\0") || resolveShellWord(destination, context) === undefined) return [dynamicRedirectUnit(node)];
		return [{ action: "write_redirect", target: { kind: "path", value: path.posix.resolve(resolved.value), unmapped: true }, remember: false }];
	}
	return context.cwd.flatMap((cwd) => resolvePathCandidates(resolved, cwd)).map((target) => target === undefined ? dynamicRedirectUnit(node) : {
		action: "write_redirect",
		target: {
			kind: "path", value: displayTemporaryPath(target.value),
			...(target.directory === undefined ? {} : { directory: target.directory }),
			...(target.numericName === undefined ? {} : { numericName: target.numericName }),
		},
		...(target.temporary ? { effect_scope: "temporary" } : {}),
		remember: target.directory === undefined,
	});
}

function dynamicRedirectUnit(node: SyntaxNode): ApprovalUnit {
	const value = normalizeSource(node.text);
	return {
		action: "write_redirect",
		target: { kind: "command", value },
		analysisFact: "shell.run-opaque-input",
		remember: false,
	};
}

function writesFile(operator: string, node: SyntaxNode): boolean {
	if (operator === ">" || operator === ">>" || operator === ">|" || operator === "&>" || operator === "&>>") return true;
	if (operator === ">&") return node.childForFieldName("descriptor") === null;
	return false;
}

function commandEffectsStayTemporary(facts: CommandFacts, context: BashAnalysisContext, direct: boolean): boolean {
	if (facts.program !== "rm" && facts.program !== "rmdir" && facts.program !== "git") return false;
	if (!facts.args.every((arg) => typeof arg === "string")) return false;
	if (facts.program !== "git") {
		if (facts.program === "rmdir" && hasRmdirParentsOption(facts.args)) return false;
		const operands = commandOperands(facts.args);
		if (operands.length === 0) return false;
		return operands.every((operand) => {
			const temporary = isSyntheticTemporaryPath(operand);
			return context.cwd.every(cwd => resolvePath({ value: operand, temporary }, cwd)?.temporary === true);
		});
	}
	if (!direct || !context.gitEnvKnown || context.functionNames.has("git")) return false;
	const directories = temporaryGitDirectories(facts.args);
	return directories !== undefined && context.cwd.every(cwd => {
		for (const dest of directories) {
			const resolved = resolvePath(shellArgumentValue(dest), cwd);
			if (!resolved) return false;
			cwd = resolved;
		}
		return cwd.temporary;
	});
}

function hasRmdirParentsOption(args: string[]): boolean {
	return args.some((argument) => argument === "--parents"
		|| (argument.startsWith("-") && !argument.startsWith("--") && argument.slice(1).includes("p")));
}

function commandOperands(args: string[]): string[] {
	const operands: string[] = [];
	let optionsEnded = false;
	for (const argument of args) {
		if (!optionsEnded && argument === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && argument.startsWith("-") && argument !== "-") continue;
		operands.push(argument);
	}
	return operands;
}

export function resolveShellWord(
	node: SyntaxNode,
	context: BashAnalysisContext,
	allowUnquotedExpansion = false,
	allowGlob = false,
): ResolvedShellValue | undefined {
	const field = singleField(node, context);
	if (field !== undefined) return shellArgumentValue(field);
	const temporary = temporaryPathAssignment(node, context);
	if (temporary !== undefined) {
		const quoted = node.text.startsWith("\"") && node.text.endsWith("\"");
		return allowUnquotedExpansion || quoted ? temporary : undefined;
	}
	const source = shellWordSource(node);
	return source === undefined ? undefined : resolveShellToken(source, context, allowUnquotedExpansion, allowGlob);
}

function unwrapCommand(input: CommandFacts): CommandFacts {
	let facts = input;
	for (let depth = 0; depth < 8; depth += 1) {
		const program = facts.program;
		if (program === undefined) return facts;
		if (program === "env" && facts.args.length > 0) {
			facts = commandAfterEnv(facts.args);
			continue;
		}
		if (program === "builtin" || program === "command" || program === "exec") {
			const next = builtinOperand(program, facts.args);
			if (next === undefined) return facts;
			facts = next; continue;
		}
		if (program === "nohup" || program === "time") {
			facts = commandAfterOptions(facts.args, NO_OPTIONS_WITH_VALUE);
			continue;
		}
		return facts;
	}
	return { ...facts, program: undefined };
}

/** undefined 表示没有被调用的程序，program: undefined 表示存在无法解析的操作数。 */
function builtinOperand(wrapper: string, args: ShellArg[]): CommandFacts | undefined {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--") { i++; break; }
		if (typeof arg !== "string" || !arg.startsWith("-") || arg === "-") break;
		if (wrapper === "command" && /^-[pvV]+$/u.test(arg)) {
			if (/[vV]/u.test(arg)) return;
		} else if (wrapper === "exec" && /^-[cl]*(?:a.*)?$/u.test(arg)) {
			if (/^-[cl]*a$/u.test(arg)) i++;
		} else return { program: undefined, args: [] };
		i++;
	}
	if (i < args.length) return { program: commandBasename(args[i]), args: args.slice(i + 1) };
}

function effectiveCommand(facts: CommandFacts): CommandFacts {
	let current = facts;
	for (let depth = 0; depth < 8 && current.program === "sudo"; depth += 1) {
		current = unwrapCommand(commandAfterOptions(current.args, SUDO_OPTIONS_WITH_VALUE, true));
	}
	return current.program === "sudo" ? { ...current, program: undefined } : current;
}

function commandAfterEnv(args: ShellArg[]): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (typeof value !== "string") return { program: undefined, args: args.slice(index + 1) };
		if (value === "--") {
			index += 1;
			break;
		}
		if (value === "-S" || value === "--split-string" || value.startsWith("--split-string=")) {
			return { program: undefined, args: args.slice(index + 1) };
		}
		if (value === "-u" || value === "--unset" || value === "-C" || value === "--chdir") {
			index += 2;
			continue;
		}
		if (value.startsWith("--unset=") || value.startsWith("--chdir=")) {
			index += 1;
			continue;
		}
		if (value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
			index += 1;
			continue;
		}
		break;
	}
	return { program: commandBasename(args[index]), args: args.slice(index + 1) };
}

function commandAfterOptions(
	args: ShellArg[],
	optionsWithValue: ReadonlySet<string>,
	skipAssignments = false,
): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (typeof value !== "string") return { program: undefined, args: args.slice(index + 1) };
		if (value === "--") {
			index += 1;
			break;
		}
		if (skipAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
			index += 1;
			continue;
		}
		if (!value.startsWith("-") || value === "-") break;
		const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
		index += optionsWithValue.has(option) && !value.includes("=") ? 2 : 1;
	}
	return { program: commandBasename(args[index]), args: args.slice(index + 1) };
}

function shellInvocation(facts: CommandFacts): { script: string; argsStart: number } | "dynamic" | undefined {
	if (facts.program === undefined) return "dynamic";
	if (!SHELL_PROGRAMS.has(facts.program)) return undefined;
	const index = shellCommandIndex(facts.args);
	if (index === undefined) return undefined;
	const script = facts.args[index + 1];
	if (typeof script !== "string") return "dynamic";
	return { script, argsStart: index + 3 };
}

function shellCommandIndex(args: ShellArg[]): number | undefined {
	for (const [index, value] of args.entries()) {
		if (value === "-c" || (typeof value === "string" && value.startsWith("-") && !value.startsWith("--") && value.slice(1).includes("c"))) return index;
	}
	return undefined;
}

function commandBasename(value: ShellArg | undefined): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}
