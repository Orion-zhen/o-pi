import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { parseSkillFile } from "./frontmatter.js";
import type { LoadedSkill, SkillCandidate, SkillContextConfig } from "./types.js";

/** 将 Pi 0.80.3 的 systemPromptOptions.skills 和 getCommands() skill 项统一为候选列表。 */
export function collectSkillCandidates(options: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]): SkillCandidate[] {
	const candidates: SkillCandidate[] = [];
	for (const skill of options?.skills ?? []) {
		candidates.push({
			name: skill.name,
			path: skill.filePath,
			description: skill.description,
			scope: skill.sourceInfo.scope,
		});
	}
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const candidate = candidateFromCommand(command);
		if (candidate !== undefined) candidates.push(candidate);
	}
	return firstCandidatePerName(candidates);
}

export function findSkillCandidate(name: string, candidates: SkillCandidate[]): SkillCandidate | undefined {
	return candidates.find((candidate) => candidate.name === name);
}

/** host 侧读取并解析 SKILL.md；不会调用模型 read 工具。 */
export async function loadSkill(candidate: SkillCandidate, config: SkillContextConfig): Promise<LoadedSkill> {
	const raw = await readFile(candidate.path, "utf8");
	const parsed = parseSkillFile(raw, path.basename(path.dirname(candidate.path)), config.max_body_chars);
	if (parsed.name !== candidate.name) {
		throw new Error(`skill frontmatter name "${parsed.name}" does not match command "${candidate.name}".`);
	}
	return {
		name: parsed.name,
		description: parsed.description,
		path: candidate.path,
		baseDir: path.dirname(candidate.path),
		body: parsed.body,
		contentHash: createHash("sha256").update(raw).digest("hex"),
	};
}

function candidateFromCommand(command: SlashCommandInfo): SkillCandidate | undefined {
	const pathValue = command.sourceInfo.path;
	const rawName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
	if (rawName.length === 0 || pathValue.length === 0) return undefined;
	return {
		name: rawName,
		path: pathValue,
		...(command.description !== undefined ? { description: command.description } : {}),
		scope: command.sourceInfo.scope,
	};
}

function firstCandidatePerName(candidates: SkillCandidate[]): SkillCandidate[] {
	const seen = new Set<string>();
	const result: SkillCandidate[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.name)) continue;
		seen.add(candidate.name);
		result.push(candidate);
	}
	return result;
}
