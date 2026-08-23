import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FilesystemPathAccess } from "../filesystem/contracts/access.js";
import { isValidSkillName } from "./frontmatter.js";
import { loadedSkillsByName } from "./state.js";
import type { SkillCandidate } from "./types.js";

export interface SkillPath {
	kind: "skill";
	logicalPath: string;
	skillName: string;
	relativePath: string;
}

export interface SkillResourceResolution extends SkillPath {
	filePath: string;
}

export interface SkillPathIndex {
	lexicalRoots: string[];
	canonicalRoots(): Promise<string[]>;
}

export interface SkillResourceError {
	kind: "error";
	code: "invalid-locator" | "access-denied";
	message: string;
	path: string;
}

/** 为一个扩展实例构建只读 skill 候选及根目录索引。 */
export function buildSkillPathIndex(candidates: SkillCandidate[]): SkillPathIndex {
	const lexicalRoots = unique(candidates.map((candidate) => path.resolve(path.dirname(candidate.path))));
	let canonicalRoots: Promise<string[]> | undefined;
	return {
		lexicalRoots,
		canonicalRoots() {
			canonicalRoots ??= resolveCanonicalRoots(lexicalRoots);
			return canonicalRoots;
		},
	};
}

/** 构建文件系统调用所需的已授权技能挂载和普通路径绕过保护。 */
export async function buildSkillFilesystemAccess(
	branch: SessionEntry[],
	index: SkillPathIndex,
): Promise<FilesystemPathAccess> {
	const mounts = [...loadedSkillsByName(branch).values()].map((skill) => ({
		logicalRoot: `skill://${skill.name}`,
		nativeRoot: path.resolve(skill.root),
	}));
	return {
		mounts,
		protectedRoots: unique([...mounts.map((mount) => mount.nativeRoot), ...index.lexicalRoots, ...await index.canonicalRoots()]),
		managedSchemes: ["skill"],
	};
}

/** 将已加载技能中的逻辑资源地址解析为受根目录约束的真实路径。 */
export async function resolveSkillResourceLocator(
	inputPath: string,
	branch: SessionEntry[],
): Promise<SkillResourceResolution | SkillResourceError> {
	const parsed = parseSkillPath(inputPath);
	if (parsed.kind === "error") return parsed;
	const loaded = loadedSkillsByName(branch).get(parsed.skillName);
	if (loaded === undefined) return denied(inputPath, `Skill "${parsed.skillName}" is not loaded on this branch.`);

	let target: string;
	try {
		target = await realpath(path.join(loaded.root, parsed.relativePath));
	} catch {
		return invalid(inputPath, "Skill resource does not exist.");
	}
	if (!isInsideOrEqual(loaded.root, target)) return denied(inputPath, "Skill resource escapes its skill root.");

	return { ...parsed, filePath: target };
}

export function parseSkillPath(input: string): SkillPath | SkillResourceError {
	if (!input.startsWith("skill://") || input.includes("\0") || input.includes("\\")
		|| input.includes("?") || input.includes("#") || input.includes("%")) {
		return invalid(input, "Invalid skill locator syntax.");
	}
	const segments = input.slice("skill://".length).split("/");
	const skillName = segments.shift();
	if (skillName === undefined || !isValidSkillName(skillName)) {
		return invalid(input, "Expected skill://<skill-name>[/<relative-path>].");
	}
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		return invalid(input, "Skill resource path contains a forbidden segment.");
	}
	return { kind: "skill", logicalPath: input, skillName, relativePath: segments.join("/") };
}

function isInsideOrEqual(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

async function resolveCanonicalRoots(lexicalRoots: string[]): Promise<string[]> {
	return unique((await Promise.all(lexicalRoots.map(async (root) => {
		try { return await realpath(root); } catch { return undefined; }
	}))).filter((root): root is string => root !== undefined));
}

function invalid(inputPath: string, message: string): SkillResourceError {
	return { kind: "error", code: "invalid-locator", message, path: inputPath };
}

function denied(inputPath: string, message: string): SkillResourceError {
	return { kind: "error", code: "access-denied", message, path: inputPath };
}
