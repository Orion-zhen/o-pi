import { PermissionCommandError, type ParsedPermissionCommand } from "./permission-command.js";

const COMMANDS = new Set(["help", "status", "catalog", "explain", "set", "reset", "roots", "grants", "profile", "policy", "audit", "maintenance"]);
const SUBCOMMANDS = new Map<string, Set<string>>([
	["catalog", new Set(["tools", "help"])],
	["roots", new Set(["add", "remove", "help"])],
	["grants", new Set(["show", "revoke", "clear", "help"])],
	["profile", new Set(["set", "reset", "help"])],
	["policy", new Set(["validate", "doctor", "reload", "edit", "show", "help"])],
	["audit", new Set(["tail", "show", "help"])],
	["maintenance", new Set(["on", "off", "help"])],
]);

/** slash command parser：处理引号、转义、flag、位置参数和 -- 终止符。 */
export function parsePermissionCommand(raw: string): ParsedPermissionCommand {
	const tokens = tokenize(raw);
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
	let positionalOnly = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (!positionalOnly && token === "--") {
			positionalOnly = true;
			continue;
		}
		if (!positionalOnly && token.startsWith("--") && token.length > 2) {
			const [rawName, inlineValue] = token.slice(2).split("=", 2);
			const name = rawName ?? "";
			if (name === "") throw new PermissionCommandError("PERMISSION_COMMAND_PARSE_ERROR", `Invalid flag: ${token}`);
			if (inlineValue !== undefined) {
				flags.set(name, inlineValue);
				continue;
			}
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("-") && flagRequiresValue(name)) {
				flags.set(name, next);
				index += 1;
			} else {
				flags.set(name, true);
			}
			continue;
		}
		positionals.push(token);
	}
	const path = commandPath(positionals);
	return { path, positionals: positionals.slice(path.length), flags, raw };
}

/** 轻量命令建议，避免引入大型依赖。 */
export function suggestCommand(input: string, candidates: readonly string[]): string[] {
	return candidates
		.map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
		.filter((item) => item.distance <= 3 || item.candidate.startsWith(input[0] ?? ""))
		.sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
		.slice(0, 3)
		.map((item) => item.candidate);
}

function commandPath(positionals: readonly string[]): string[] {
	const first = positionals[0];
	if (first === undefined) return [];
	if (first === "help" || first === "-h") return ["help"];
	if (!COMMANDS.has(first)) return [first];
	const second = positionals[1];
	const allowed = SUBCOMMANDS.get(first);
	if (second !== undefined && (second === "help" || second === "-h" || allowed?.has(second))) return [first, second === "-h" ? "help" : second];
	return [first];
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let tokenStarted = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index] ?? "";
		if (char === "\\") {
			const next = input[index + 1];
			if (next === undefined) {
				current += char;
			} else if (next === "\\" || next === "\"" || next === "'" || /\s/.test(next)) {
				index += 1;
				current += next;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			tokenStarted = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (tokenStarted) {
				tokens.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}
		current += char;
		tokenStarted = true;
	}
	if (quote !== undefined) {
		throw new PermissionCommandError("PERMISSION_COMMAND_PARSE_ERROR", `Unclosed quote after:\n  /permissions ${input}`);
	}
	if (tokenStarted) tokens.push(current);
	return tokens;
}

function flagRequiresValue(name: string): boolean {
	return name === "count";
}

function levenshtein(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= right.length; j += 1) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length] ?? 0;
}
