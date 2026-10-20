import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CODEX_SPEEDS = ["normal", "fast", "ultrafast"] as const;
export type CodexSpeed = typeof CODEX_SPEEDS[number];
export const CODEX_SPEED_ENTRY = "codex-speed";
export const CODEX_SPEED_CHANGED = "opi:codex-speed-changed";

export function isCodexSpeed(value: unknown): value is CodexSpeed {
	return CODEX_SPEEDS.some((speed) => speed === value);
}

/** 只读取当前分支，不为其他提供方应用速度偏好。 */
export function getCodexSpeed(provider: string | undefined, branch: readonly SessionEntry[]): CodexSpeed | null {
	if (provider !== "openai" && provider !== "openai-codex") return null;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === CODEX_SPEED_ENTRY && isCodexSpeed(entry.data)) return entry.data;
	}
	return "normal";
}

export function setCodexSpeed(
	provider: string | undefined,
	speed: CodexSpeed,
	branch: readonly SessionEntry[],
	appendEntry: (customType: string, data: CodexSpeed) => void,
): boolean {
	const current = getCodexSpeed(provider, branch);
	if (current === null) throw new Error("Codex speed requires openai or openai-codex.");
	if (current === speed) return false;
	appendEntry(CODEX_SPEED_ENTRY, speed);
	return true;
}
