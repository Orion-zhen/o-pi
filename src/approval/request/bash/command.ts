import type { SyntaxNode } from "../../../syntax-tree/types.js";
import type { ApprovalUnit } from "../../types.js";
import {
	TEMPORARY_DIRECTORY_PATH,
	TEMPORARY_FILE_PATH,
	allDefined,
	displayTemporaryPath,
	isSyntheticTemporaryPath,
	resolvePath,
	resolveShellToken,
	setPositionalVariables,
	shellArgumentValue,
	singleValue,
	type BashAnalysisContext,
	type ResolvedShellValue,
} from "./state.js";
import { commandWords, normalizeCommandNode, normalizeSource, walkNamedNodes } from "./syntax.js";

const SHELL_PROGRAMS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u",
	"--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user",
]);

export interface CommandFacts {
	program: string | undefined;
	args: Array<string | undefined>;
}

interface NestedShell {
	script: string;
	positional: Map<string, ResolvedShellValue>;
}

interface ParsedCommand {
	unit: ApprovalUnit;
	rawFacts: CommandFacts;
	nestedShell: NestedShell | undefined;
	cdTarget: ResolvedShellValue | undefined;
}

function successfulCdTarget(raw: CommandFacts, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (raw.program !== "cd" && raw.program !== "command" && raw.program !== "builtin") return undefined;
	const facts = raw.program === "cd" ? raw : unwrapCommand(raw);
	if (facts.program !== "cd") return undefined;
	let destination: ResolvedShellValue | undefined;
	for (const value of facts.args) {
		if (value === undefined) return undefined;
		if (value === "--") continue;
		if (value.startsWith("-")) return undefined;
		if (destination !== undefined) return undefined;
		destination = { value, temporary: isSyntheticTemporaryPath(value) };
	}
	return destination === undefined ? undefined : resolvePath(destination, context.cwd, ".");
}

export function temporaryPathAssignment(node: SyntaxNode, context: BashAnalysisContext): ResolvedShellValue | undefined {
	if (node.type === "string") {
		const child = singleValue(node.namedChildren);
		return child?.type === "command_substitution" && node.text === `"${child.text}"`
			? temporaryPathAssignment(child, context)
			: undefined;
	}
	if (node.type !== "command_substitution") return undefined;
	const command = singleValue([...walkNamedNodes(node, () => {})].filter((candidate) => candidate.type === "command"));
	if (command === undefined) return undefined;
	const facts = unwrapCommand(commandFacts(command, context));
	if (facts.program !== "mktemp" || !allDefined(facts.args)) return undefined;
	const directory = mktempDirectoryMode(facts.args);
	if (directory === undefined) return undefined;
	return {
		value: directory ? TEMPORARY_DIRECTORY_PATH : TEMPORARY_FILE_PATH,
		temporary: true,
	};
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

export function commandUnit(node: SyntaxNode, context: BashAnalysisContext): ParsedCommand {
	const { facts: rawFacts, contextResolved } = resolveCommand(node, context);
	const facts = unwrapCommand(rawFacts);
	const nestedShell = shellInvocation(effectiveCommand(facts));
	const exactValue = normalizeCommandNode(node);
	const temporary = commandEffectsStayTemporary(facts, context.cwd);
	return {
		unit: {
			action: "execute",
			target: {
				kind: "command",
				value: exactValue,
				effective_value: commandView(facts),
			},
			...(temporary ? { effect_scope: "temporary" as const } : {}),
			remember: {
				session: !contextResolved,
				persistent: !contextResolved && isRememberableCommand(facts, nestedShell !== undefined),
			},
		},
		rawFacts,
		nestedShell,
		cdTarget: successfulCdTarget(rawFacts, context),
	};
}

export function commandFacts(node: SyntaxNode, context: BashAnalysisContext): CommandFacts {
	return resolveCommand(node, context).facts;
}

function resolveCommand(node: SyntaxNode, context: BashAnalysisContext): { facts: CommandFacts; contextResolved: boolean } {
	let contextResolved = false;
	const values = commandWords(node).map((word, index) => {
		if (word.literal !== undefined) return word.literal;
		const resolved = word.source === word.node.text
			? resolveShellWord(word.node, context, false, index > 0)
			: resolveShellToken(word.source, context, false, index > 0);
		if (resolved !== undefined) contextResolved = true;
		return resolved?.value;
	});
	const [program, ...args] = values;
	return { facts: { program: commandBasename(program), args }, contextResolved };
}

export function redirectUnit(node: SyntaxNode, context: BashAnalysisContext, cwd: string): ApprovalUnit | undefined {
	const operator = node.children.find((child) => !child.isNamed)?.text;
	if (operator === undefined || !writesFile(operator, node)) return undefined;
	const destination = node.childForFieldName("destination");
	if (destination === null) return dynamicRedirectUnit(node);
	if (destination.type === "process_substitution") return undefined;
	const resolved = resolveShellWord(destination, context, false, true);
	if (resolved === undefined) return dynamicRedirectUnit(node);
	if (operator === ">&" && (resolved.value === "-" || /^\d+$/u.test(resolved.value))) return undefined;
	const target = resolvePath(resolved, context.cwd, cwd);
	if (target === undefined) return dynamicRedirectUnit(node);
	return {
		action: "write_redirect",
		target: { kind: "path", value: displayTemporaryPath(target.value) },
		...(target.temporary ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
}

function dynamicRedirectUnit(node: SyntaxNode): ApprovalUnit {
	const value = normalizeSource(node.text);
	return {
		action: "write_redirect",
		target: { kind: "command", value, effective_value: `<dynamic> ${value}` },
		remember: { session: false, persistent: false },
	};
}

function writesFile(operator: string, node: SyntaxNode): boolean {
	if (operator === ">" || operator === ">>" || operator === ">|" || operator === "&>" || operator === "&>>") return true;
	if (operator === ">&") return node.childForFieldName("descriptor") === null;
	return false;
}

function commandEffectsStayTemporary(facts: CommandFacts, cwd: ResolvedShellValue): boolean {
	if (facts.program === "rm" || facts.program === "rmdir") {
		if (facts.program === "rmdir" && hasRmdirParentsOption(facts.args)) return false;
		const operands = commandOperands(facts.args);
		if (operands.length === 0 || !allDefined(operands)) return false;
		return operands.every((operand) => {
			const temporary = isSyntheticTemporaryPath(operand);
			return resolvePath({ value: operand, temporary }, cwd, ".")?.temporary === true;
		});
	}
	if (facts.program !== "git" || !allDefined(facts.args)) return false;
	const invocation = temporaryGitInvocation(facts.args, cwd);
	return invocation !== undefined
		&& (invocation.command === "clean" || invocation.command === "reset" && invocation.args.includes("--hard"));
}

function hasRmdirParentsOption(args: Array<string | undefined>): boolean {
	return args.some((argument) => argument === "--parents"
		|| (argument?.startsWith("-") === true && !argument.startsWith("--") && argument.slice(1).includes("p")));
}

function temporaryGitInvocation(
	args: readonly string[],
	initialCwd: ResolvedShellValue,
): { command: string; args: string[] } | undefined {
	let cwd = { ...initialCwd };
	let nextIndex = 0;
	for (const [index, argument] of args.entries()) {
		if (index < nextIndex) continue;
		if (argument === "-C") {
			const destination = args[index + 1];
			if (destination === undefined) return undefined;
			const resolved = resolvePath(shellArgumentValue(destination), cwd, ".");
			if (resolved === undefined) return undefined;
			cwd = resolved;
			nextIndex = index + 2;
			continue;
		}
		if (argument === "--git-dir" || argument === "--work-tree"
			|| argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=")) return undefined;
		if (["--no-pager", "--paginate", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]
			.includes(argument)) continue;
		if (argument.startsWith("-")) return undefined;
		return cwd.temporary ? { command: argument, args: args.slice(index + 1) } : undefined;
	}
	return undefined;
}

function commandOperands(args: Array<string | undefined>): Array<string | undefined> {
	const operands: Array<string | undefined> = [];
	let optionsEnded = false;
	for (const argument of args) {
		if (!optionsEnded && argument === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && argument?.startsWith("-") === true && argument !== "-") continue;
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
	const temporary = temporaryPathAssignment(node, context);
	if (temporary !== undefined) {
		const quoted = node.text.startsWith("\"") && node.text.endsWith("\"");
		return allowUnquotedExpansion || quoted ? temporary : undefined;
	}
	return resolveShellToken(node.text, context, allowUnquotedExpansion, allowGlob);
}

function isRememberableCommand(facts: CommandFacts, parsedLiteralShell: boolean, depth = 0): boolean {
	const program = facts.program;
	if (program === undefined) return false;
	if (program === "sudo") {
		if (depth >= 8) return false;
		const nested = unwrapCommand(commandAfterOptions(facts.args, SUDO_OPTIONS_WITH_VALUE, true));
		return isRememberableCommand(nested, parsedLiteralShell, depth + 1);
	}
	if (program === "eval") return false;
	return !SHELL_PROGRAMS.has(program) || shellCommandIndex(facts.args) === undefined || parsedLiteralShell;
}

function unwrapCommand(input: CommandFacts): CommandFacts {
	let facts = input;
	for (let depth = 0; depth < 8; depth += 1) {
		const program = facts.program;
		if (program === undefined) return facts;
		if (program === "env") {
			facts = commandAfterEnv(facts.args);
			continue;
		}
		if (program === "builtin" || program === "command" || program === "exec" || program === "nohup" || program === "time") {
			facts = commandAfterOptions(facts.args, NO_OPTIONS_WITH_VALUE);
			continue;
		}
		return facts;
	}
	return { ...facts, program: undefined };
}

function effectiveCommand(facts: CommandFacts): CommandFacts {
	let current = facts;
	for (let depth = 0; depth < 8 && current.program === "sudo"; depth += 1) {
		current = unwrapCommand(commandAfterOptions(current.args, SUDO_OPTIONS_WITH_VALUE, true));
	}
	return current.program === "sudo" ? { ...current, program: undefined } : current;
}

function commandAfterEnv(args: Array<string | undefined>): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (value === undefined) return { program: undefined, args: args.slice(index + 1) };
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
	args: Array<string | undefined>,
	optionsWithValue: ReadonlySet<string>,
	skipAssignments = false,
): CommandFacts {
	let index = 0;
	while (index < args.length) {
		const value = args[index];
		if (value === undefined) return { program: undefined, args: args.slice(index + 1) };
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

function shellInvocation(facts: CommandFacts): NestedShell | undefined {
	if (facts.program === undefined || !SHELL_PROGRAMS.has(facts.program)) return undefined;
	const index = shellCommandIndex(facts.args);
	if (index === undefined) return undefined;
	const script = facts.args[index + 1];
	if (script === undefined) return undefined;
	const positional = new Map<string, ResolvedShellValue>();
	setPositionalVariables(positional, facts.args.slice(index + 3));
	return { script, positional };
}

function shellCommandIndex(args: Array<string | undefined>): number | undefined {
	for (const [index, value] of args.entries()) {
		if (value === "-c" || (value?.startsWith("-") === true && !value.startsWith("--") && value.slice(1).includes("c"))) return index;
	}
	return undefined;
}

function commandView(facts: CommandFacts): string {
	return [
		facts.program ?? "<dynamic>",
		...facts.args.map((value) => value === undefined ? "<dynamic>" : displayTemporaryPath(value)),
	].join(" ");
}

function commandBasename(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}
