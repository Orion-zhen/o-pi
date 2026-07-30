import { getTreeSitterLanguage } from "../syntax-tree/grammars.js";
import { parseSyntaxTree } from "../syntax-tree/parser.js";
import type { SyntaxNode } from "../syntax-tree/types.js";
import { normalizeTargetPath } from "./path.js";
import type { ApprovalUnit } from "./types.js";

const MAX_BASH_UNITS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;
const BASH_GRAMMAR = getTreeSitterLanguage("bash").grammar;
const DYNAMIC_NODE_TYPES = new Set([
	"arithmetic_expansion",
	"brace_expansion",
	"command_substitution",
	"expansion",
	"extglob_pattern",
	"process_substitution",
	"simple_expansion",
]);
const SHELL_PROGRAMS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const NO_OPTIONS_WITH_VALUE = new Set<string>();
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u",
	"--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user",
]);

interface ParsedBashUnits {
	units: ApprovalUnit[];
}

interface CommandFacts {
	program: string | undefined;
	args: Array<string | undefined>;
}

class BashUnitLimitError extends Error {}

/** 将 Bash AST 拆成可独立匹配的简单命令和文件写重定向。 */
export async function parseBashApprovalUnits(command: string, cwd: string): Promise<ParsedBashUnits> {
	try {
		const units: ApprovalUnit[] = [];
		const parsed = await parseScript(command, cwd, 0, units);
		if (!parsed) return { units: [opaqueCommandUnit(command)] };
		if (units.length === 0) units.push(plainCommandUnit(command));
		return { units };
	} catch {
		return { units: [opaqueCommandUnit(command)] };
	}
}

function opaqueCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: `<opaque> ${command}` },
		remember: { session: true, persistent: false },
	};
}

function plainCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: command },
		remember: { session: true, persistent: true },
	};
}

async function parseScript(script: string, cwd: string, depth: number, units: ApprovalUnit[]): Promise<boolean> {
	if (depth > MAX_NESTED_SHELL_DEPTH) throw new BashUnitLimitError();
	const parsed = await parseSyntaxTree(BASH_GRAMMAR, script);
	const document = parsed.document;
	if (document === undefined) return false;
	try {
		if (document.root.hasError) return false;
		for (const node of walkNamedNodes(document.root, document.control.check)) {
			if (node.type === "command") {
				const command = commandUnit(node);
				pushUnit(units, command.unit);
				if (command.nestedScript !== undefined && !await parseScript(command.nestedScript, cwd, depth + 1, units)) {
					throw new BashUnitLimitError();
				}
				continue;
			}
			if (node.type === "file_redirect") {
				const redirect = redirectUnit(node, cwd);
				if (redirect !== undefined) pushUnit(units, redirect);
			}
		}
	} finally {
		document.dispose();
	}
	return true;
}

function* walkNamedNodes(root: SyntaxNode, check: () => void): Generator<SyntaxNode> {
	const stack = [root];
	while (stack.length > 0) {
		check();
		const node = stack.pop();
		if (node === undefined) break;
		yield node;
		for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
			const child = node.namedChildren[index];
			if (child !== undefined) stack.push(child);
		}
	}
}

function commandUnit(node: SyntaxNode): { unit: ApprovalUnit; nestedScript?: string } {
	const nameNode = node.childForFieldName("name");
	const argumentNodes = node.childrenForFieldName("argument");
	const program = nameNode === null ? undefined : literalNodeText(nameNode);
	const args = argumentNodes.map(literalNodeText);
	const rawFacts = { program: commandBasename(program), args };
	const facts = unwrapCommand(rawFacts);
	const nestedScript = shellScript(effectiveCommand(facts));
	const exactValue = normalizeCommandNode(node);
	const matchValue = commandView(rawFacts);
	const similarValue = commandView(facts);
	return {
		unit: {
			action: "execute",
			target: {
				kind: "command",
				value: exactValue,
				match_value: matchValue,
				...(similarValue === matchValue ? {} : { similar_value: similarValue }),
			},
			remember: {
				session: true,
				persistent: isRememberableCommand(facts, nestedScript !== undefined),
			},
		},
		...(nestedScript === undefined ? {} : { nestedScript }),
	};
}

function redirectUnit(node: SyntaxNode, cwd: string): ApprovalUnit | undefined {
	const operator = node.children.find((child) => !child.isNamed)?.text;
	if (operator === undefined || !writesFile(operator, node)) return undefined;
	const destination = node.childForFieldName("destination");
	if (destination === null) return dynamicRedirectUnit(node);
	if (destination.type === "process_substitution") return undefined;
	const literal = literalNodeText(destination);
	if (literal === undefined) return dynamicRedirectUnit(node);
	if (operator === ">&" && (literal === "-" || /^\d+$/u.test(literal))) return undefined;
	const targetPath = normalizeTargetPath(literal, cwd);
	return {
		action: "write_redirect",
		target: { kind: "path", value: targetPath },
		remember: { session: true, persistent: true },
	};
}

function dynamicRedirectUnit(node: SyntaxNode): ApprovalUnit {
	const value = normalizeSource(node.text);
	return {
		action: "write_redirect",
		target: { kind: "command", value, match_value: `<dynamic> ${value}` },
		remember: { session: false, persistent: false },
	};
}

function writesFile(operator: string, node: SyntaxNode): boolean {
	if (operator === ">" || operator === ">>" || operator === ">|" || operator === "&>" || operator === "&>>") return true;
	if (operator === ">&") return node.childForFieldName("descriptor") === null;
	return false;
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

function shellScript(facts: CommandFacts): string | undefined {
	if (facts.program === undefined || !SHELL_PROGRAMS.has(facts.program)) return undefined;
	const index = shellCommandIndex(facts.args);
	return index === undefined ? undefined : facts.args[index + 1];
}

function shellCommandIndex(args: Array<string | undefined>): number | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (value === "-c" || (value?.startsWith("-") === true && !value.startsWith("--") && value.slice(1).includes("c"))) return index;
	}
	return undefined;
}

function commandView(facts: CommandFacts): string {
	return [facts.program ?? "<dynamic>", ...facts.args.map((value) => value ?? "<dynamic>")].join(" ");
}

function normalizeCommandNode(node: SyntaxNode): string {
	const parts = node.namedChildren
		.filter((child) => child.type !== "file_redirect" && child.type !== "heredoc_redirect" && child.type !== "herestring_redirect")
		.map((child) => normalizeSource(child.text))
		.filter((part) => part.length > 0);
	return parts.length === 0 ? normalizeSource(node.text) : parts.join(" ");
}

function literalNodeText(node: SyntaxNode): string | undefined {
	if (containsDynamicNode(node)) return undefined;
	return decodeShellToken(node.text);
}

function containsDynamicNode(root: SyntaxNode): boolean {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) break;
		if (DYNAMIC_NODE_TYPES.has(node.type)) return true;
		for (const child of node.namedChildren) stack.push(child);
	}
	return false;
}

function decodeShellToken(source: string): string | undefined {
	let result = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === undefined) break;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else result += character;
			continue;
		}
		if (quote === "\"") {
			if (character === "\"") {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const next = source[index + 1];
				if (next === undefined) return undefined;
				if (next === "\n") {
					index += 1;
					continue;
				}
				result += next === "$" || next === "`" || next === "\"" || next === "\\"
					? next
					: `\\${next}`;
				index += 1;
				continue;
			}
			if (character === "$" || character === "`") return undefined;
			result += character;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			continue;
		}
		if (character === "\\") {
			const next = source[index + 1];
			if (next === undefined) return undefined;
			result += next;
			index += 1;
			continue;
		}
		if (character === "$" || character === "`" || character === "*" || character === "?" || character === "[" || character === "{") return undefined;
		if (character === "~" && index === 0) return undefined;
		result += character;
	}
	return quote === undefined ? result : undefined;
}

function normalizeSource(value: string): string {
	let result = "";
	let quote: "'" | "\"" | undefined;
	let pendingSpace = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === undefined) break;
		if (quote !== undefined) {
			result += character;
			if (quote === "\"" && character === "\\") {
				const next = value[index + 1];
				if (next !== undefined) {
					result += next;
					index += 1;
				}
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (/\s/u.test(character)) {
			pendingSpace = result.length > 0;
			continue;
		}
		if (pendingSpace) {
			result += " ";
			pendingSpace = false;
		}
		result += character;
		if (character === "'" || character === "\"") quote = character;
		else if (character === "\\") {
			const next = value[index + 1];
			if (next !== undefined) {
				result += next;
				index += 1;
			}
		}
	}
	return result;
}

function commandBasename(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const normalized = value.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function pushUnit(units: ApprovalUnit[], unit: ApprovalUnit): void {
	if (units.length >= MAX_BASH_UNITS) throw new BashUnitLimitError();
	units.push(unit);
}
