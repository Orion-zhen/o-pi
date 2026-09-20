import type { SkillLoadDetails } from "../harness/skill-context/types.ts";

export const skillLoaders: Record<SkillLoadDetails["loadedBy"], string> = { manual: "手动引用", agent: "模型调用" };
export const skillScopes: Record<SkillLoadDetails["scope"], string> = { user: "用户技能", project: "项目技能", temporary: "临时技能" };

export function isSkillLoadDetails(value: unknown): value is SkillLoadDetails {
	if (typeof value !== "object" || value === null) return false;
	return "name" in value && typeof value.name === "string"
		&& "root" in value && typeof value.root === "string"
		&& "contentHash" in value && typeof value.contentHash === "string"
		&& "scope" in value && (value.scope === "user" || value.scope === "project" || value.scope === "temporary")
		&& "loadedBy" in value && (value.loadedBy === "manual" || value.loadedBy === "agent")
		&& "deduplicated" in value && typeof value.deduplicated === "boolean"
		&& "chars" in value && typeof value.chars === "number";
}
