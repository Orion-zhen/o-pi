import path from "node:path";
import { scanStaticPowerShellWord } from "../syntax-tree/powershell.ts";
import { stringProperty } from "./streaming.ts";
import type { PresenceActivity, PresenceActivityKind } from "./types.ts";

const SEARCH_TOOLS = new Set([
	"grep",
	"find",
	"ls",
	"glob",
	"search",
	"code_pattern",
	"lsp_workspace_symbols",
	"lsp_references",
	"lsp_definition",
]);
const BROWSE_TOOLS = new Set(["webfetch", "websearch", "fetch", "browse", "fetch_content"]);
const FILE_ACTIVITY_KINDS = new Set<PresenceActivityKind>(["reading", "editing", "writing"]);

const LANGUAGES: Readonly<Record<string, { key: string; label: string }>> = {
	".c": { key: "c", label: "C" },
	".cc": { key: "cpp", label: "C++" },
	".cpp": { key: "cpp", label: "C++" },
	".css": { key: "css", label: "CSS" },
	".go": { key: "go", label: "Go" },
	".html": { key: "html", label: "HTML" },
	".java": { key: "java", label: "Java" },
	".js": { key: "javascript", label: "JavaScript" },
	".json": { key: "json", label: "JSON" },
	".jsonc": { key: "json", label: "JSONC" },
	".jsx": { key: "javascript", label: "JavaScript JSX" },
	".lua": { key: "lua", label: "Lua" },
	".md": { key: "markdown", label: "Markdown" },
	".ps1": { key: "shell", label: "PowerShell" },
	".psm1": { key: "shell", label: "PowerShell" },
	".py": { key: "python", label: "Python" },
	".rb": { key: "ruby", label: "Ruby" },
	".rs": { key: "rust", label: "Rust" },
	".sh": { key: "shell", label: "Shell" },
	".sql": { key: "sql", label: "SQL" },
	".toml": { key: "toml", label: "TOML" },
	".ts": { key: "typescript", label: "TypeScript" },
	".tsx": { key: "typescript", label: "TypeScript JSX" },
	".vue": { key: "vue", label: "Vue" },
	".xml": { key: "xml", label: "XML" },
	".yaml": { key: "yaml", label: "YAML" },
	".yml": { key: "yaml", label: "YAML" },
	".zig": { key: "zig", label: "Zig" },
};

export function classifyTool(toolName: string, args: unknown, commandComplete = true): PresenceActivity {
	const normalized = toolName.toLowerCase();
	const targetPath = stringProperty(args, "path");
	if (normalized === "read" || normalized === "edit" || normalized === "write") {
		const basename = targetPath === undefined || /[\\/]$/u.test(targetPath) ? "" : path.win32.basename(targetPath);
		const file = basename.length === 0 ? undefined : basename;
		const language = file === undefined ? undefined : languageFor(file);
		return {
			kind: normalized === "read" ? "reading" : normalized === "edit" ? "editing" : "writing",
			tool: toolName,
			...(file === undefined ? {} : { file }),
			...(language === undefined ? {} : { language: language.label, languageKey: language.key }),
		};
	}
	if (SEARCH_TOOLS.has(normalized)) return { kind: "searching", tool: toolName };
	if (BROWSE_TOOLS.has(normalized)) return { kind: "browsing", tool: toolName };
	if (normalized === "powershell" || normalized === "bash") {
		const command = stringProperty(args, "command");
		const extract = normalized === "powershell" ? powerShellExecutable : bashExecutable;
		const executable = command === undefined ? undefined : extract(command, commandComplete);
		return {
			kind: "shell",
			tool: toolName,
			...(executable === undefined ? {} : { executable }),
		};
	}
	return { kind: "other_tool", tool: toolName };
}

// 只展示命令位置的静态名称。普通字符串、控制语句和动态调用都不是程序名。
function powerShellExecutable(command: string, complete: boolean): string | undefined {
	let source = command.trimStart();
	// 跳过已完整结束的字面赋值，不把变量名、值或表达式当作程序名。
	for (;;) {
		const assignment = /^\$(?:env:)?[a-z_]\w*[ \t]*=[ \t]*/iu.exec(source);
		if (!assignment) break;
		const rhs = scanStaticPowerShellWord(source, assignment[0].length);
		if (!rhs || !/^["']/u.test(source.charAt(rhs.start)) && !/^\d+$/u.test(rhs.value)) return;
		const separator = /^[ \t]*(?:;|\r?\n)/u.exec(source.slice(rhs.end));
		if (!separator) return;
		source = source.slice(rhs.end + separator[0].length).trimStart();
	}
	const operator = /^(?:&\s*|\.\s+)/u.exec(source)?.[0];
	const start = operator?.length ?? 0;
	if (!operator && /^["'\d]/u.test(source)) return;
	const word = scanStaticPowerShellWord(source, start);
	if (!word || !complete && word.end === source.length || /[\\/]$/u.test(word.value)) return;
	const name = path.win32.basename(word.value);
	if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.'-]*(?: [\p{L}\p{N}_][\p{L}\p{N}_.'-]*)*$/u.test(name)) return;
	if (!operator && /^(?:begin|break|catch|class|clean|continue|data|define|do|dynamicparam|else|elseif|end|enum|exit|filter|finally|for|foreach|from|function|if|in|param|process|return|switch|throw|trap|try|until|using|while|workflow)$/iu.test(word.value)) return;
	return name;
}

/** 仅在首个非赋值 Bash 词已由分隔符终结，或输入明确结束时返回程序名。 */
function bashExecutable(command: string, inputComplete: boolean): string | undefined {
	let cursor = 0;
	while (cursor < command.length) {
		while (cursor < command.length && isShellSeparator(command[cursor] ?? "")) cursor += 1;
		if (cursor >= command.length) return undefined;

		let value = "";
		let quote: "'" | "\"" | undefined;
		let escaped = false;
		let terminated = false;
		for (; cursor < command.length; cursor += 1) {
			const character = command[cursor] ?? "";
			if (escaped) {
				value += character;
				escaped = false;
				continue;
			}
			if (character === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (quote !== undefined) {
				if (character === quote) quote = undefined;
				else value += character;
				continue;
			}
			if (character === "'" || character === "\"") {
				quote = character;
				continue;
			}
			if (isShellSeparator(character)) {
				terminated = true;
				break;
			}
			value += character;
		}

		if (!terminated && (!inputComplete || quote !== undefined || escaped)) return undefined;
		if (value.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
			return path.basename(value) || undefined;
		}
	}
	return undefined;
}

export function preserveStableMetadata(
	previous: PresenceActivity | undefined,
	next: PresenceActivity,
): PresenceActivity {
	if (previous === undefined) return next;
	if (FILE_ACTIVITY_KINDS.has(previous.kind) && FILE_ACTIVITY_KINDS.has(next.kind) && previous.file !== undefined) {
		return {
			kind: next.kind,
			tool: next.tool,
			file: previous.file,
			...(previous.language === undefined ? {} : { language: previous.language }),
			...(previous.languageKey === undefined ? {} : { languageKey: previous.languageKey }),
		};
	}
	if (previous.kind === "shell" && next.kind === "shell" && previous.executable !== undefined) {
		return { ...next, executable: previous.executable };
	}
	return next;
}

function languageFor(file: string): { key: string; label: string } | undefined {
	return LANGUAGES[path.extname(file).toLowerCase()];
}

function isShellSeparator(character: string): boolean {
	return /[\s;&|<>()]/u.test(character);
}
