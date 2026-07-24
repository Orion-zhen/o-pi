import * as os from "os";
import {
	parseFrontmatter,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/subagent/agents.js";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import {
	loadAndValidateForkSystemPrompt,
	validateForkRuntime,
} from "../../src/subagent/session-context.js";
import type { AgentDefinition } from "../../src/subagent/types.js";
import type { TokenCounterScope } from "../../src/token-counter.js";
import { collectModelInvocableSkillIndex } from "../../src/skill-context/loader.js";

const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";
type PromptSections = {
	/** Pi 传入的 appendSystemPrompt 会作为独立段落插入，避免和自定义 prompt 混写后边界不清。 */
	appendSystemPrompt: string | undefined;
	/** 工具策略来自 Pi 的 promptGuidelines，并追加本扩展固定的最小工具选择规则。 */
	toolPolicy: string;
	/** 只索引明确允许模型加载的技能，不披露路径和正文。 */
	modelInvocableSkills: string | undefined;
	skillPolicy: string | undefined;
	/** AGENTS.md 等项目上下文由 Pi 预加载，本扩展只负责重新包成 XML 风格。 */
	projectContext: string | undefined;
	/** 运行时临时段落，例如主 Agent 可见的 subagent 索引。 */
	extraSections: string[];
	/** 当前日期按 Pi 默认 prompt 语义保留，但统一放到最后的 context 区。 */
	date: string;
	/** Windows 路径转为正斜杠，降低模型把反斜杠当转义符的概率。 */
	cwd: string;
};

/** 构建 system prompt；保留 Pi 默认信息来源，但用更短的 XML section 替代默认长文本并移除 skill 元数据。 */
export function buildSystemPrompt(
	options: BuildSystemPromptOptions,
	extraSections: string[] = [],
	modelInvocableSkills: Array<{ name: string; description: string }> = [],
): string {
	const sections = collectPromptSections(options, extraSections, modelInvocableSkills);
	if (options.customPrompt) {
		return formatCustomPrompt(normalizeLineEndings(options.customPrompt), sections);
	}
	return formatDefaultPrompt(sections);
}

/** 从 Pi 加载的原始 Agent Markdown 构建子 Agent system prompt，以独立角色取代默认 role。 */
export function buildSubagentSystemPrompt(options: BuildSystemPromptOptions): string {
	if (!options.customPrompt) throw new Error("Subagent Agent Markdown is required.");
	const { body } = parseFrontmatter(normalizeLineEndings(options.customPrompt));
	const sections = collectPromptSections(options, [], []);
	return joinSections([
		formatSubagentRole(body),
		...formatSharedPromptSections(sections),
	]);
}

/** 主 Agent 可见的精简 subagent 索引；只暴露选择所需信息，避免把子 Agent 系统提示泄露给主 Agent。 */
export function formatAvailableSubagentsPrompt(agents: AgentDefinition[]): string {
	if (agents.length === 0) return "";

	const lines = ["<subagents>"];
	for (const agent of agents) {
		lines.push(`- ${agent.name}: ${agent.description}`);
	}
	lines.push("</subagents>");
	return lines.join("\n");
}

/** 注册 /system 命令，用只读浮层查看当前 system prompt；内容不会写入会话历史。 */
export function registerSystemCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("system", {
		description: SYSTEM_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return;

			// 命令上下文的 getSystemPromptOptions() 是 Pi 暴露的结构化基础输入；
			// 它不包含当前命令渲染出的 prompt，因此这里必须复用本扩展的构建函数。
			const systemPromptOptions = ctx.getSystemPromptOptions();
			const prompt = await buildRuntimeSystemPrompt(systemPromptOptions, ctx.cwd);
			const { SystemPromptViewer } = await import("../../src/tui/system-prompt-viewer.js");
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new SystemPromptViewer(prompt, theme, () => tui.terminal.rows, done, tokenScopeFromModel(ctx.model)),
			);
		},
	});
}

/** 在每轮开始前接管 system prompt 构建，改为 XML 风格并移除 Pi 默认的 skill 列表。 */
export default function systemPrompt(pi: ExtensionAPI): void {
	registerSystemCommand(pi);

	// before_agent_start 返回 systemPrompt 表示完整替换；Pi 会把它作为本轮 provider 请求的最终系统提示词。
	pi.on("before_agent_start", async (event, ctx) => {
		const activeTools = pi.getActiveTools();
		const subagentToolAvailable = activeTools.includes("subagent");

		if (process.env.PI_SUBAGENT_FORK === "1") {
			try {
				const manifestPath = requireForkEnv("PI_SUBAGENT_FORK_MANIFEST");
				const snapshotPath = process.env.PI_SUBAGENT_FORK_SNAPSHOT;
				await validateForkRuntime({
					manifestPath,
					...(snapshotPath !== undefined ? { snapshotPath } : {}),
					model: ctx.model,
					activeTools,
					allTools: pi.getAllTools(),
					thinkingLevel: pi.getThinkingLevel(),
					sessionId: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
				});
				return { systemPrompt: await buildRuntimeSystemPrompt(event.systemPromptOptions, ctx.cwd, subagentToolAvailable) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(message);
				return { systemPrompt: `<fork_setup_error>${message}</fork_setup_error>` };
			}
		}
		return { systemPrompt: await buildRuntimeSystemPrompt(event.systemPromptOptions, ctx.cwd, subagentToolAvailable) };
	});
}

function collectPromptSections(
	options: BuildSystemPromptOptions,
	extraSections: string[],
	modelInvocableSkills: Array<{ name: string; description: string }>,
): PromptSections {
	const contextFiles = options.contextFiles ?? [];

	return {
		appendSystemPrompt: formatAppendSystemPrompt(options.appendSystemPrompt),
		toolPolicy: formatToolPolicy(options.promptGuidelines),
		modelInvocableSkills: formatModelInvocableSkills(modelInvocableSkills),
		skillPolicy: modelInvocableSkills.length > 0 ? formatSkillPolicy() : undefined,
		projectContext: formatProjectContext(contextFiles),
		extraSections,
		date: formatLocalDate(new Date()),
		cwd: options.cwd.replace(/\\/g, "/"),
	};
}

function formatDefaultPrompt(sections: PromptSections): string {
	return joinSections([
		`<role>You are an interactive agent that helps users with coding tasks. You ALWAYS respond in user's language.</role>`,
		...formatSharedPromptSections(sections),
	]);
}

function formatSubagentRole(agentInstructions: string): string {
	const instructions = normalizeLineEndings(agentInstructions).trim();
	const lines = [
		"<subagent_role>",
		"You are a subagent working for the primary agent. Complete the assigned task within its scope and return the result to the primary agent. You ALWAYS respond in user's language.",
	];
	if (instructions.length > 0) lines.push("", instructions);
	lines.push("</subagent_role>");
	return lines.join("\n");
}

function formatCustomPrompt(customPrompt: string, sections: PromptSections): string {
	return joinSections([
		`<custom_prompt>
${customPrompt}
</custom_prompt>`,
		...formatSharedPromptSections(sections),
	]);
}

function formatSharedPromptSections(sections: PromptSections): Array<string | undefined> {
	return [
		sections.toolPolicy,
		sections.skillPolicy,
		sections.modelInvocableSkills,
		sections.appendSystemPrompt,
		sections.projectContext,
		...sections.extraSections,
		formatRuntimeContext(sections.date, sections.cwd),
	];
}

function formatAppendSystemPrompt(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = normalizeLineEndings(value).trim();
	if (trimmed.length === 0) return undefined;
	return `<append_system_prompt>
${trimmed}
</append_system_prompt>`;
}

function formatToolPolicy(promptGuidelines: BuildSystemPromptOptions["promptGuidelines"]): string {
	const rules = unique([
		"Use the narrowest active tool that directly matches the operation.",
		"Minimize redundant tool calls; maximize evidence efficiency.",
		"Issue independent tool calls together in one response; keep dependent operations sequential.",
		"Do not retrieve unchanged content already in context unless omitted details, an intervening write, or a stale result requires it.",
		...normalizeGuidelines(promptGuidelines),
	]);

	return `<tool_policy>
${rules.map((rule) => `- ${rule}`).join("\n")}
</tool_policy>`;
}

function formatSkillPolicy(): string {
	return `<skill_policy>
- Relative paths mentioned by a loaded skill resolve under skill://<skill-name>/.
- Load the narrowest skill that clearly matches the user's requested outcome.
- Classify by the requested outcome, not incidental steps such as reading or editing a repository.
- Do NOT load the same skill repeatedly.
</skill_policy>`;
}

export function formatModelInvocableSkills(skills: Array<{ name: string; description: string }>): string | undefined {
	if (skills.length === 0) return undefined;
	const lines = skills.map(({ name, description }) => `- ${name}: ${escapeXml(description.replace(/\s+/g, " ").trim())}`);
	return `<model_invocable_skills>\n${lines.join("\n")}\n</model_invocable_skills>`;
}

function normalizeGuidelines(promptGuidelines: BuildSystemPromptOptions["promptGuidelines"]): string[] {
	return (promptGuidelines ?? []).map((guideline) => guideline.trim()).filter((guideline) => guideline.length > 0);
}

function formatProjectContext(contextFiles: NonNullable<BuildSystemPromptOptions["contextFiles"]>): string | undefined {
	if (contextFiles.length === 0) return undefined;

	const files = contextFiles
		.map(
			({ path, content }) => `<project_instructions path="${escapeXml(path)}">
${normalizeLineEndings(content)}
</project_instructions>`,
		)
		.join("\n\n");

	return `<project_context>
${files}
</project_context>`;
}

function formatRuntimeContext(date: string, cwd: string): string {
	return `<context>
Date: ${date}
OS: ${escapeXml(getSystemInfo())}
Workspace: ${escapeXml(cwd)}
</context>`;
}

/** 构造人类可读的当前操作系统名称与版本字符串。 */
function getSystemInfo(): string {
	const type = os.type();
	const release = os.release();

	if (type === "Linux") return `Linux`;
	if (type === "Darwin") return `macOS ${release.split(".")[0]}`;
	if (type === "Windows_NT") return `Windows ${release}`;
	return `${type} ${release}`;
}

function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function unique(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) === index);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function joinSections(sections: Array<string | undefined>): string {
	return sections.filter((section): section is string => section !== undefined && section.length > 0).join("\n\n");
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function tokenScopeFromModel(model: { provider?: string; id?: string; baseUrl?: string } | undefined): TokenCounterScope {
	return {
		...(model?.provider !== undefined ? { provider: model.provider } : {}),
		...(model?.id !== undefined ? { modelId: model.id } : {}),
		...(model?.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
	};
}

export async function buildRuntimeSystemPrompt(
	options: BuildSystemPromptOptions,
	cwd: string,
	subagentToolAvailable = true,
): Promise<string> {
	if (process.env.PI_SUBAGENT_FORK === "1") {
		return loadAndValidateForkSystemPrompt(
			requireForkEnv("PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE"),
			requireForkEnv("PI_SUBAGENT_FORK_MANIFEST"),
		);
	}
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return buildSubagentSystemPrompt(options);
	}
	const extraSections = await getMainAgentExtraSystemPrompt(cwd, subagentToolAvailable);
	const modelInvocableSkills = collectModelInvocableSkillIndex(options);
	return buildSystemPrompt(options, extraSections, modelInvocableSkills);
}

function requireForkEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`fork setup error: ${name} is unavailable`);
	return value;
}

async function getMainAgentExtraSystemPrompt(cwd: string, subagentToolAvailable: boolean): Promise<string[]> {
	if (!subagentToolAvailable) return [];
	const config = await loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, config);
	const subagents = formatAvailableSubagentsPrompt(discovery.agents);
	return subagents === "" ? [] : [subagents];
}
