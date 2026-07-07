export interface PatternGuardConfig {
	deny_patterns?: string[];
	deny_regex?: string[];
}

export interface PatternDenyMatch {
	code: "BLOCKED_PATTERN";
	kind: "pattern" | "regex";
	rule: string;
	message: string;
}

export class PatternGuardConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "PatternGuardConfigError";
	}
}

export function checkDeniedText(text: string, config: PatternGuardConfig | undefined): PatternDenyMatch | null {
	for (const pattern of config?.deny_patterns ?? []) {
		if (!globPatternMatches(text, pattern)) continue;
		return {
			code: "BLOCKED_PATTERN",
			kind: "pattern",
			rule: pattern,
			message: "Text blocked by deny pattern.",
		};
	}
	for (const rule of config?.deny_regex ?? []) {
		const regex = compileRegex(rule);
		if (!regex.test(text)) continue;
		return {
			code: "BLOCKED_PATTERN",
			kind: "regex",
			rule,
			message: "Text blocked by deny regex.",
		};
	}
	return null;
}

export function validatePatternGuardConfig(config: PatternGuardConfig | undefined): void {
	for (const rule of config?.deny_regex ?? []) compileRegex(rule);
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

function compileRegex(rule: string): RegExp {
	try {
		return new RegExp(rule);
	} catch (error) {
		throw new PatternGuardConfigError("deny_regex contains an invalid regular expression.", {
			rule,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
