import path from "node:path";
import type { PresenceActivity, PresenceActivityKind } from "./types.js";

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

interface ActiveTool {
	id: string;
	activity: PresenceActivity;
}

export interface PresenceActivityState {
	turnActive: boolean;
	activeTools: readonly ActiveTool[];
}

export function initialPresenceActivityState(): PresenceActivityState {
	return { turnActive: false, activeTools: [] };
}

export function startTurn(state: PresenceActivityState): PresenceActivityState {
	return { ...state, turnActive: true };
}

export function settleAgent(): PresenceActivityState {
	return initialPresenceActivityState();
}

export function startTool(
	state: PresenceActivityState,
	toolCallId: string,
	toolName: string,
	args: unknown,
): PresenceActivityState {
	return updateTool(state, toolCallId, toolCallId, toolName, args);
}

/** 原子替换流式临时 ID，并保留同一调用已稳定识别的文件名或 executable。 */
export function updateTool(
	state: PresenceActivityState,
	previousToolCallId: string,
	toolCallId: string,
	toolName: string,
	args: unknown,
): PresenceActivityState {
	const previous = state.activeTools.find((tool) => tool.id === previousToolCallId)
		?? state.activeTools.find((tool) => tool.id === toolCallId);
	const activity = preserveStableMetadata(previous?.activity, classifyTool(toolName, args));
	return {
		turnActive: true,
		activeTools: [
			...state.activeTools.filter((tool) => tool.id !== previousToolCallId && tool.id !== toolCallId),
			{ id: toolCallId, activity },
		],
	};
}

export function endTool(state: PresenceActivityState, toolCallId: string): PresenceActivityState {
	return { ...state, activeTools: state.activeTools.filter((tool) => tool.id !== toolCallId) };
}

export function currentActivity(state: PresenceActivityState): PresenceActivity {
	const active = state.activeTools.at(-1);
	if (active !== undefined) return active.activity;
	return state.turnActive
		? { kind: "thinking", tool: "" }
		: { kind: "idle", tool: "" };
}

export function classifyTool(toolName: string, args: unknown): PresenceActivity {
	const normalized = toolName.toLowerCase();
	const input = asRecord(args);
	const targetPath = stringValue(input, "path");
	if (normalized === "read" || normalized === "edit" || normalized === "write") {
		const basename = targetPath === undefined || /[\\/]$/u.test(targetPath) ? "" : path.basename(targetPath);
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
	if (normalized === "bash") {
		const command = stringValue(input, "command");
		const executable = command === undefined ? undefined : stableExecutableFromCommand(command, true);
		return {
			kind: "shell",
			tool: toolName,
			...(executable === undefined ? {} : { executable }),
		};
	}
	return { kind: "other_tool", tool: toolName };
}

/** 仅在首个非赋值 Shell word 已由分隔符终结，或输入明确结束时返回 executable。 */
export function stableExecutableFromCommand(command: string, inputComplete: boolean): string | undefined {
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
			return path.basename(value) || value;
		}
	}
	return undefined;
}

function preserveStableMetadata(
	previous: PresenceActivity | undefined,
	next: PresenceActivity,
): PresenceActivity {
	if (previous === undefined) return next;
	if (FILE_ACTIVITY_KINDS.has(previous.kind) && FILE_ACTIVITY_KINDS.has(next.kind) && previous.file !== undefined) {
		return {
			...next,
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

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
