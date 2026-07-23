import * as os from "os";
import {
	parseFrontmatter,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "../../src/subagent/agents.js";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import type { AgentDefinition } from "../../src/subagent/types.js";
import { countTextTokensSync, type TokenCounterScope } from "../../src/token-counter.js";
import { collectModelInvocableSkillIndex } from "../../src/skill-context/loader.js";

const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";
const VIEWER_BODY_ROWS_RATIO = 0.75;
const VIEWER_NON_BODY_ROWS = 5;

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
	pi.on("before_agent_start", async (event, ctx) => ({
		systemPrompt: await buildRuntimeSystemPrompt(event.systemPromptOptions, ctx.cwd),
	}));
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
		`<role>You are an expert coding assistant operating inside pi, a coding agent harness. You ALWAYS respond in user's language.</role>`,
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
		"Minimize model round trips, not necessary evidence.",
		"Call a tool only when its result can change the next decision or verify completion.",
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
<date>${date}</date>
<system>${escapeXml(getSystemInfo())}</system>
<workspace>${escapeXml(cwd)}</workspace>
</context>`;
}

/** 构造人类可读的当前操作系统名称与版本字符串。 */
function getSystemInfo(): string {
	const type = os.type();
	const release = os.release();

	if (type === "Linux") return `Linux ${release}`;
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

/** 只读滚动查看 system prompt；该组件只在 custom UI 生命周期内存在，不会修改模型上下文。 */
export class SystemPromptViewer implements Component {
	private readonly content: string;
	private readonly tokenCount: number;
	private scrollTop = 0;

	constructor(
		content: string,
		private readonly theme: Theme,
		private readonly getRows: () => number,
		private readonly done: () => void,
		tokenScope: TokenCounterScope = {},
	) {
		this.content = normalizeLineEndings(content);
		this.tokenCount = countTextTokensSync(this.content, tokenScope).tokens;
	}

	handleInput(data: string): void {
		const pageSize = this.getBodyHeight();
		if (this.isCloseKey(data)) {
			this.done();
			return;
		}

		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-pageSize);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(pageSize);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = Number.MAX_SAFE_INTEGER;
	}

	render(width: number): string[] {
		if (width < 1) return [];

		const bodyHeight = this.getBodyHeight();
		const bodyLines = this.formatBody(width);
		this.clampScroll(bodyLines.length, bodyHeight);

		return [
			this.formatHeader(width, bodyLines.length, bodyHeight),
			this.fitLine(this.theme.fg("dim", "Read-only view. Up/Down/Page/Home/End scroll, Esc/q/Enter closes."), width),
			this.fitLine("", width),
			...this.formatVisibleBody(bodyLines, bodyHeight).map((line) => this.fitLine(line, width)),
		];
	}

	invalidate(): void {}

	private isCloseKey(data: string): boolean {
		return matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q");
	}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	private clampScroll(totalLines: number, bodyHeight: number): void {
		const maxScrollTop = Math.max(0, totalLines - bodyHeight);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScrollTop);
	}

	private getBodyHeight(): number {
		// custom UI 没有单独的视口高度参数；用终端行数估算，给标题和提示预留固定行。
		return Math.max(1, Math.floor(this.getRows() * VIEWER_BODY_ROWS_RATIO) - VIEWER_NON_BODY_ROWS);
	}

	private formatHeader(width: number, bodyLineCount: number, bodyHeight: number): string {
		const rawLineCount = this.content.split("\n").length;
		const title = this.theme.bold(`System prompt (${this.content.length} chars, ~${this.tokenCount} tokens, ${rawLineCount} lines)`);
		const position =
			bodyLineCount > bodyHeight
				? ` ${this.scrollTop + 1}-${Math.min(bodyLineCount, this.scrollTop + bodyHeight)}/${bodyLineCount}`
				: "";
		return this.fitLine(this.theme.fg("accent", title) + this.theme.fg("dim", position), width);
	}

	private formatVisibleBody(bodyLines: string[], bodyHeight: number): string[] {
		const visibleBody = bodyLines.slice(this.scrollTop, this.scrollTop + bodyHeight);
		while (visibleBody.length < bodyHeight) visibleBody.push("");
		return visibleBody;
	}

	private formatBody(width: number): string[] {
		const lines = this.content.split("\n");
		const numberWidth = String(lines.length).length;
		const textWidth = Math.max(1, width - numberWidth - 3);
		const formatted: string[] = [];

		lines.forEach((line, index) => {
			// 每一行单独按终端列宽折行；后续折行保留空行号，让用户能区分原始行与视觉折行。
			const wrapped = wrapByColumns(line.length > 0 ? line : " ", textWidth);
			const firstPrefix = `${String(index + 1).padStart(numberWidth, " ")} | `;
			const nextPrefix = `${" ".repeat(numberWidth)} | `;
			wrapped.forEach((part, partIndex) => {
				const prefix = partIndex === 0 ? firstPrefix : nextPrefix;
				formatted.push(this.theme.fg("dim", prefix) + part);
			});
		});

		return formatted;
	}

	private fitLine(content: string, width: number): string {
		return truncateToWidth(content, width, "", true);
	}
}

function tokenScopeFromModel(model: { provider?: string; id?: string; baseUrl?: string } | undefined): TokenCounterScope {
	return {
		...(model?.provider !== undefined ? { provider: model.provider } : {}),
		...(model?.id !== undefined ? { modelId: model.id } : {}),
		...(model?.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
	};
}

function wrapByColumns(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;

	// Intl.Segmenter 按字素簇切分，避免把中文、emoji 或组合字符截到不可显示的中间状态。
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const segmentWidth = visibleWidth(segment);
		if (current && currentWidth + segmentWidth > width) {
			lines.push(current);
			current = "";
			currentWidth = 0;
		}

		if (segmentWidth > width) continue;
		current += segment;
		currentWidth += segmentWidth;
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [" "];
}

export async function buildRuntimeSystemPrompt(options: BuildSystemPromptOptions, cwd: string): Promise<string> {
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return buildSubagentSystemPrompt(options);
	}
	const extraSections = await getMainAgentExtraSystemPrompt(cwd);
	const modelInvocableSkills = collectModelInvocableSkillIndex(options);
	return buildSystemPrompt(options, extraSections, modelInvocableSkills);
}

async function getMainAgentExtraSystemPrompt(cwd: string): Promise<string[]> {
	const config = await loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, config);
	const subagents = formatAvailableSubagentsPrompt(discovery.agents);
	return subagents === "" ? [] : [subagents];
}
