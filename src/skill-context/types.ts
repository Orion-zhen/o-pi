/** skill context 写入 session 的 customType，custom entry 不会被 Pi 默认加入模型上下文。 */
export const SKILL_CONTEXT_ENTRY = "o-pi:skill-context";

/** skill 状态卡片写入 custom_message；context hook 会过滤它，避免进入模型上下文。 */
export const SKILL_CONTEXT_STATUS_MESSAGE = "o-pi:skill-context-status";

export type SkillContextEntry = SkillActivationEntry | SkillDeactivationEntry;

/** host 侧读取后的 skill 激活记录；body 是去掉 frontmatter 后的正文。 */
export interface SkillActivationEntry {
	kind: "activation";
	name: string;
	description: string;
	path: string;
	baseDir: string;
	body: string;
	contentHash: string;
	scope: "task";
	loadedAt: string;
}

/** skill 停用记录；lazy 保留旧 body 以维持 prompt cache 前缀，hard 允许后续上下文省略 body。 */
export interface SkillDeactivationEntry {
	kind: "deactivation";
	name?: string;
	mode: "lazy" | "hard";
	reason: "user_clear" | "conflict_replace";
	clearedAt: string;
}

/** 当前配置文件版本固定为 1，字段保持少量且直接对应运行时行为。 */
export interface SkillContextConfig {
	version: 1;
	enabled: boolean;
	max_active: number;
	on_load_conflict: "replace" | "stack";
	clear_mode: "lazy" | "hard";
	dedupe_read: boolean;
	max_body_chars: number;
}

/** Pi skill 来源统一后的候选项；只加载用户点名的文件，不扫描额外路径。 */
export interface SkillCandidate {
	name: string;
	path: string;
	description?: string;
	scope: "user" | "project" | "temporary";
}

/** 已加载 skill 的模型可见数据。 */
export interface LoadedSkill {
	name: string;
	description: string;
	path: string;
	baseDir: string;
	body: string;
	contentHash: string;
}

export interface SkillContextState {
	entries: SkillContextEntry[];
	active: LoadedSkill[];
	retained: LoadedSkill[];
	hardClearedNames: Set<string>;
}

/** TUI 状态卡片数据；只用于展示，不作为模型上下文。 */
export interface SkillContextStatusMessage {
	action: "loaded" | "inactive" | "cleared";
	name?: string;
	mode?: "lazy" | "hard";
	chars?: number;
	path?: string;
}
