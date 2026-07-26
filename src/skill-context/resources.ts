import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isValidSkillName } from "./frontmatter.js";
import { loadedSkillsByName } from "./state.js";
import type { SkillCandidate } from "./types.js";

export interface SkillResourceResolution {
	kind: "skill";
	filePath: string;
	logicalPath: string;
	skillName: string;
	relativePath: string;
}

export interface OrdinaryPathResolution {
	kind: "ordinary";
}

export interface SkillReadIndex {
	candidates: SkillCandidate[];
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
export function buildSkillReadIndex(candidates: SkillCandidate[]): SkillReadIndex {
	const lexicalRoots = unique(candidates.map((candidate) => path.resolve(path.dirname(candidate.path))));
	let canonicalRoots: Promise<string[]> | undefined;
	return {
		candidates,
		lexicalRoots,
		canonicalRoots() {
			canonicalRoots ??= resolveCanonicalRoots(lexicalRoots);
			return canonicalRoots;
		},
	};
}

export async function resolveReadLocator(
	inputPath: string,
	branch: SessionEntry[],
	index: SkillReadIndex,
): Promise<SkillResourceResolution | OrdinaryPathResolution | SkillResourceError> {
	if (!inputPath.startsWith("skill://")) {
		if (path.isAbsolute(inputPath) && await isManagedSkillAbsolutePath(inputPath, branch, index)) {
			return denied(inputPath, "Managed skill files must be read through an authorized skill:// locator.");
		}
		return { kind: "ordinary" };
	}

	const parsed = parseSkillLocator(inputPath);
	if (parsed.kind === "error") return parsed;
	const loaded = loadedSkillsByName(branch).get(parsed.skillName);
	if (loaded === undefined) return denied(inputPath, `Skill "${parsed.skillName}" is not loaded on this branch.`);

	let target: string;
	try {
		target = await realpath(path.join(loaded.root, ...parsed.segments));
	} catch {
		return invalid(inputPath, "Skill resource does not exist.");
	}
	if (!isInside(loaded.root, target)) return denied(inputPath, "Skill resource escapes its skill root.");

	return {
		kind: "skill",
		filePath: target,
		logicalPath: inputPath,
		skillName: parsed.skillName,
		relativePath: parsed.relativePath,
	};
}

function parseSkillLocator(input: string): { skillName: string; relativePath: string; segments: string[]; kind?: never } | SkillResourceError {
	if (input.includes("\0") || input.includes("\\") || input.includes("?") || input.includes("#") || input.includes("%")) {
		return invalid(input, "Invalid skill locator syntax.");
	}
	const rest = input.slice("skill://".length);
	const segments = rest.split("/");
	const skillName = segments.shift();
	if (skillName === undefined || !isValidSkillName(skillName) || segments.length === 0) {
		return invalid(input, "Expected skill://<skill-name>/<relative-path>.");
	}
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		return invalid(input, "Skill resource path contains a forbidden segment.");
	}
	return { skillName, relativePath: segments.join("/"), segments };
}

async function isManagedSkillAbsolutePath(input: string, branch: SessionEntry[], index: SkillReadIndex): Promise<boolean> {
	const lexical = path.resolve(input);
	const loadedRoots = unique([...loadedSkillsByName(branch).values()].map((skill) => path.resolve(skill.root)));
	const lexicalRoots = [...loadedRoots, ...index.lexicalRoots];
	if (lexicalRoots.some((root) => isInsideOrEqual(root, lexical))) return true;

	let targetReal: string | undefined;
	try { targetReal = await realpath(lexical); } catch {}
	if (targetReal === undefined) return false;
	return [...loadedRoots, ...await index.canonicalRoots()].some((root) => isInsideOrEqual(root, targetReal));
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative.length > 0
		&& relative !== ".."
		&& !relative.startsWith(`..${path.sep}`)
		&& !path.isAbsolute(relative);
}

function isInsideOrEqual(root: string, target: string): boolean {
	return root === target || isInside(root, target);
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
