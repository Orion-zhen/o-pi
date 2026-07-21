import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { parseSkillFile } from "./frontmatter.js";
import type { LoadedSkill, SkillCandidate } from "./types.js";

/** 合并框架的提示词技能与斜杠命令发现结果，同名时 project 覆盖 user。 */
export function collectSkillCandidates(options: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]): SkillCandidate[] {
	const candidates: SkillCandidate[] = [];
	for (const skill of options?.skills ?? []) {
		candidates.push({
			name: skill.name,
			path: skill.filePath,
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
			scope: skill.sourceInfo.scope,
		});
	}
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const candidate = candidateFromCommand(command);
		if (candidate !== undefined) candidates.push(candidate);
	}
	return preferredCandidatePerName(candidates);
}

export function findSkillCandidate(name: string, candidates: SkillCandidate[]): SkillCandidate | undefined {
	return candidates.find((candidate) => candidate.name === name);
}

/** 在宿主侧读取并校验技能文件，返回的正文不含前置元数据。 */
export async function loadSkill(candidate: SkillCandidate): Promise<LoadedSkill> {
	const skillPath = await realpath(candidate.path);
	const raw = await readFile(skillPath, "utf8");
	const parsed = parseSkillFile(raw, candidate.name);
	if (parsed.name !== candidate.name) {
		throw new Error(`skill frontmatter name "${parsed.name}" does not match discovered name "${candidate.name}".`);
	}
	return {
		name: parsed.name,
		description: parsed.description,
		path: skillPath,
		root: path.dirname(skillPath),
		body: parsed.body,
		contentHash: createHash("sha256").update(raw).digest("hex"),
		scope: candidate.scope,
	};
}

/** 使用 Pi 已解析的字段生成模型可调用索引，不再次读取 SKILL.md。 */
export function collectModelInvocableSkillIndex(
	options: BuildSystemPromptOptions | undefined,
): Array<Pick<LoadedSkill, "name" | "description">> {
	return collectSkillCandidates(options, [])
		.filter((candidate): candidate is SkillCandidate & { description: string } => (
			candidate.disableModelInvocation === false && candidate.description !== undefined
		))
		.map((candidate) => ({ name: candidate.name, description: candidate.description }));
}

function candidateFromCommand(command: SlashCommandInfo): SkillCandidate | undefined {
	const filePath = command.sourceInfo.path;
	const rawName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
	if (rawName.length === 0 || filePath.length === 0) return undefined;
	return {
		name: rawName,
		path: filePath,
		...(command.description !== undefined ? { description: command.description } : {}),
		scope: command.sourceInfo.scope,
	};
}

function preferredCandidatePerName(candidates: SkillCandidate[]): SkillCandidate[] {
	const selected: SkillCandidate[] = [];
	const indexByName = new Map<string, number>();
	for (const candidate of candidates) {
		const existingIndex = indexByName.get(candidate.name);
		if (existingIndex === undefined) {
			indexByName.set(candidate.name, selected.length);
			selected.push(candidate);
			continue;
		}
		const existing = selected[existingIndex];
		if (existing?.scope === "user" && candidate.scope === "project") selected[existingIndex] = candidate;
	}
	return selected;
}
