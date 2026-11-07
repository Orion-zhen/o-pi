import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FilesystemPathAccess } from "../filesystem/contracts/access.ts";
import { isValidSkillName } from "./frontmatter.ts";
import { loadedSkillsByName } from "./state.ts";
import type { SkillLoadEntry } from "./types.ts";

export interface SkillPath {
	kind: "skill";
	logicalPath: string;
	skillName: string;
	relativePath: string;
}

export interface SkillResourceResolution extends SkillPath {
	filePath: string;
}

export interface SkillResourceError {
	kind: "error";
	code: "invalid-locator" | "access-denied";
	message: string;
	path: string;
}

/** 构建文件系统调用所需的已加载技能挂载。 */
export function buildSkillFilesystemAccess(
	loads: ReadonlyMap<string, SkillLoadEntry>,
): FilesystemPathAccess {
	const mounts = [...loads.values()].map((skill) => ({
		logicalRoot: `skill://${skill.name}`,
		nativeRoot: path.resolve(skill.root),
	}));
	return {
		mounts,
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

function invalid(inputPath: string, message: string): SkillResourceError {
	return { kind: "error", code: "invalid-locator", message, path: inputPath };
}

function denied(inputPath: string, message: string): SkillResourceError {
	return { kind: "error", code: "access-denied", message, path: inputPath };
}
