import type { BashSafetyConfig } from "./types.js";

export interface PatternDenyMatch {
	kind: "pattern" | "regex";
	rule: string;
}

export function checkDeniedText(text: string, config: BashSafetyConfig): PatternDenyMatch | null {
	for (const pattern of config.deny_patterns) {
		if (!globPatternMatches(text, pattern)) continue;
		return { kind: "pattern", rule: pattern };
	}
	for (const rule of config.deny_regex) {
		if (!new RegExp(rule).test(text)) continue;
		return { kind: "regex", rule };
	}
	return null;
}

function globPatternMatches(text: string, pattern: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) return text.includes(pattern);
	return globToRegExp(pattern).test(text);
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (const char of pattern) {
		if (char === "*") source += "[\\s\\S]*";
		else if (char === "?") source += "[\\s\\S]";
		else source += escapeRegExp(char);
	}
	return new RegExp(source, "u");
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
