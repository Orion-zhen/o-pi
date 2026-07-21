/** 仅宿主可见的会话记录，用于重建当前分支的技能资源权限。 */
export const SKILL_CONTEXT_ENTRY = "o-pi:skill-load";

/** 手动技能披露使用模型可见的自定义消息，并由专用渲染器展示。 */
export const SKILL_CONTEXT_MESSAGE = "o-pi:skill";

/** 框架发现的技能；路径只对宿主可见。 */
export interface SkillCandidate {
	name: string;
	path: string;
	description?: string;
	disableModelInvocation?: boolean;
	scope: "user" | "project" | "temporary";
}

export interface LoadedSkill {
	name: string;
	description: string;
	path: string;
	root: string;
	body: string;
	contentHash: string;
	scope: SkillCandidate["scope"];
}

/** 只追加的披露记录；仅保存资源授权和去重所需字段。 */
export interface SkillLoadEntry {
	name: string;
	path: string;
	root: string;
	contentHash: string;
	scope: SkillCandidate["scope"];
	loadedBy: "agent" | "manual";
	loadedAt: string;
}

export interface SkillLoadDetails {
	name: string;
	root: string;
	contentHash: string;
	scope: SkillCandidate["scope"];
	loadedBy: SkillLoadEntry["loadedBy"];
	deduplicated: boolean;
	chars: number;
}

export interface SkillLoadResult {
	content: string;
	details: SkillLoadDetails;
}

export interface SkillToolErrorDetails {
	status: "failed";
	error: {
		code: "SKILL_NOT_FOUND" | "SKILL_NOT_LOADABLE" | "SKILL_INVALID";
		message: string;
	};
}
