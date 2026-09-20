import * as os from "os";
import { parseFrontmatter, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.ts";
import { loadSubagentConfig } from "../subagent/config.ts";
import { loadForkSystemPrompt } from "../subagent/session-context.ts";
import { collectModelInvocableSkillIndex } from "../skill-context/loader.ts";

type SkillIndex = Array<{ name: string; description: string }>;

const ROLE = "<role>You are an interactive agent that helps users with coding tasks. You ALWAYS respond in user's language.</role>";
const SKILL_POLICY = [
	"Filesystem tools resolve paths mentioned by a loaded skill under skill://<skill-name>/.",
	"Load the narrowest skill that clearly matches the user's requested outcome.",
	"Classify by the requested outcome, not incidental steps such as reading or editing a repository.",
	"Do NOT load the same skill repeatedly.",
].map((rule) => `- ${rule}`).join("\n");

/** 使用 Pi 的命名段落持久化提示词，避免每轮强制替换 leading prompt。 */
function promptOptions(
	options: BuildSystemPromptOptions,
	preamble: string,
	skills: SkillIndex,
	extraSections: Record<string, string> = {},
): BuildSystemPromptOptions {
	const cwd = options.cwd.replace(/\\/g, "/");
	const sections: Record<string, string> = {
		...options.sections,
		tool_policy: formatToolPolicy(options),
	};
	if (skills.length > 0) {
		sections.skill_policy = SKILL_POLICY;
		sections.model_invocable_skills = formatSkillIndex(skills);
	}
	const append = options.appendSystemPrompt?.trim();
	if (append) sections.append_system_prompt = normalizeLineEndings(append);
	if (options.contextFiles?.length) sections.project_context = formatProjectContext(options.contextFiles, cwd);
	Object.assign(sections, extraSections);
	// Pi 固定生成 cwd 段落，用同一段承载运行时信息，避免重复工作目录。
	sections.cwd = `Date: ${formatLocalDate(new Date())}\nOS: ${escapeXml(getSystemInfo())}\nWorkspace: ${escapeXml(cwd)}`;
	return {
		...options,
		customPrompt: preamble,
		appendSystemPrompt: "",
		contextFiles: [],
		skills: [],
		sections,
	};
}

function mainRole(options: BuildSystemPromptOptions): string {
	return options.customPrompt
		? `<custom_prompt>\n${normalizeLineEndings(options.customPrompt)}\n</custom_prompt>`
		: ROLE;
}

function subagentRole(options: BuildSystemPromptOptions): string {
	if (!options.customPrompt) throw new Error("Subagent Agent Markdown is required.");
	const { body } = parseFrontmatter(normalizeLineEndings(options.customPrompt));
	return [
		"<subagent_role>",
		"You are a subagent working for the primary agent. Complete the assigned task within its scope and return the result to the primary agent. You ALWAYS respond in user's language.",
		...(body.trim() ? ["", body.trim()] : []),
		"</subagent_role>",
	].join("\n");
}

function formatToolPolicy(options: BuildSystemPromptOptions): string {
	const rules = [
		"Use the narrowest active tool that directly matches the operation.",
		"Minimize redundant tool calls; maximize evidence efficiency.",
		"Issue independent tool calls together in one response; keep dependent operations sequential.",
		"Do not retrieve unchanged content already in context unless omitted details, an intervening write, or a stale result requires it.",
		...(options.selectedTools ?? []).flatMap((name) => options.toolGuidelines?.[name] ?? []),
		...(options.promptGuidelines ?? []),
	].map((rule) => rule.trim()).filter(Boolean);
	return [...new Set(rules)].map((rule) => `- ${rule}`).join("\n");
}

function formatSkillIndex(skills: SkillIndex): string {
	return skills.map(({ name, description }) => `- ${name}: ${escapeXml(description.replace(/\s+/g, " ").trim())}`).join("\n");
}

function formatProjectContext(files: NonNullable<BuildSystemPromptOptions["contextFiles"]>, cwd: string): string {
	return files.map(({ path, content }) => {
		const relative = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
		return `<project_instructions path="${escapeXml(relative.replace(/\\/g, "/"))}">\n${normalizeLineEndings(content).trim()}\n</project_instructions>`;
	}).join("\n\n");
}

function getSystemInfo(): string {
	const type = os.type();
	const release = os.release();
	if (type === "Linux") return "Linux";
	if (type === "Darwin") return `macOS ${release.split(".")[0]}`;
	if (type === "Windows_NT") return `Windows ${release}`;
	return `${type} ${release}`;
}

function formatLocalDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

async function runtimePromptOptions(options: BuildSystemPromptOptions, cwd: string, subagentToolAvailable: boolean): Promise<BuildSystemPromptOptions> {
	if (process.env.PI_SUBAGENT_FORK === "1") {
		const file = process.env.PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE;
		if (!file) throw new Error("fork setup error: PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE is unavailable");
		// fork 必须逐字继承父请求，不按子进程环境重建指令。
		return { ...options, forceSystemPrompt: await loadForkSystemPrompt(file) };
	}
	if (process.env.PI_SUBAGENT_CHILD === "1") return promptOptions(options, subagentRole(options), []);
	const extraSections: Record<string, string> = {};
	if (subagentToolAvailable) {
		const config = await loadSubagentConfig(cwd);
		const { agents } = discoverAgents(cwd, config);
		if (agents.length > 0) extraSections.subagents = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	}
	return promptOptions(options, mainRole(options), collectModelInvocableSkillIndex(options), extraSections);
}

/** 首次输入前预览合成结果。段落顺序与 Pi 的 customPrompt + cwd + sections 一致。 */
export async function buildRuntimeSystemPrompt(options: BuildSystemPromptOptions, cwd: string, subagentToolAvailable = true): Promise<string> {
	const prepared = await runtimePromptOptions(options, cwd, subagentToolAvailable);
	if (prepared.forceSystemPrompt !== undefined) return prepared.forceSystemPrompt;
	const sections = { cwd: prepared.cwd, ...prepared.sections };
	return [prepared.customPrompt, ...Object.entries(sections).filter(([, value]) => value.length > 0)
		.map(([name, value]) => `<${name}>\n${value}\n</${name}>`)].filter(Boolean).join("\n\n");
}

export async function configureAgentSystemPrompt(input: {
	options: BuildSystemPromptOptions;
	cwd: string;
	activeTools: readonly string[];
}): Promise<void> {
	Object.assign(input.options, await runtimePromptOptions(input.options, input.cwd, input.activeTools.includes("subagent")));
}
