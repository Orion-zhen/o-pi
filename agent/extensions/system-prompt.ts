import * as os from "os";
import type { BuildSystemPromptOptions, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "../../src/subagent/agents.js";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import type { AgentDefinition } from "../../src/subagent/types.js";
import { countTextTokensSync, type TokenCounterScope } from "../../src/token-counter.js";

const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";
const VIEWER_BODY_ROWS_RATIO = 0.75;
const VIEWER_NON_BODY_ROWS = 5;

type PromptSections = {
	/** Pi 传入的 appendSystemPrompt 会作为独立段落插入，避免和自定义 prompt 混写后边界不清。 */
	appendSystemPrompt: string | undefined;
	/** 工具策略来自 Pi 的 promptGuidelines，并追加本扩展固定的最小工具选择规则。 */
	toolPolicy: string;
	/** skill 策略只在 Pi 已扫描到 skill 时出现，不列出任何具体 skill 元数据。 */
	skillPolicy: string | undefined;
	/** 仅列出当前启用且带 prompt snippet 的工具，保持和 Pi 工具可见性一致。 */
	availableTools: string;
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
export function buildSystemPrompt(options: BuildSystemPromptOptions, extraSections: string[] = []): string {
	const sections = collectPromptSections(options, extraSections);
	if (options.customPrompt) {
		return formatCustomPrompt(normalizeLineEndings(options.customPrompt), sections);
	}
	return formatDefaultPrompt(sections);
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

/** 子 Agent 专属追加提示；正文放入 XML 标签以明确当前运行身份并隔离任意用户内容。 */
export function formatSubagentSystemPrompt(agent: AgentDefinition): string {
	return [
		`<subagent name="${escapeXml(agent.name)}" description="${escapeXml(agent.description)}">`,
		normalizeLineEndings(agent.systemPrompt),
		"</subagent>",
	].join("\n");
}

/** 注册 /system 命令，用只读浮层查看当前 system prompt；内容不会写入会话历史。 */
export function registerSystemCommand(pi: Pick<ExtensionAPI, "registerCommand"> & Partial<Pick<ExtensionAPI, "getActiveTools">>): void {
	pi.registerCommand("system", {
		description: SYSTEM_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return;

			// 命令上下文的 getSystemPromptOptions() 是 Pi 0.80.3 暴露的结构化基础输入；
			// 它不包含当前命令渲染出的 prompt，因此这里必须复用本扩展的构建函数。
			const systemPromptOptions = ctx.getSystemPromptOptions();
			const activeTools = pi.getActiveTools?.() ?? getToolsFromPromptOptions(systemPromptOptions);
			const prompt = await buildRuntimeSystemPrompt(systemPromptOptions, ctx.cwd, activeTools);
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
		systemPrompt: await buildRuntimeSystemPrompt(event.systemPromptOptions, ctx.cwd, pi.getActiveTools()),
	}));
}

function collectPromptSections(options: BuildSystemPromptOptions, extraSections: string[]): PromptSections {
	const contextFiles = options.contextFiles ?? [];
	const selectedTools = getToolsFromPromptOptions(options);

	return {
		appendSystemPrompt: formatAppendSystemPrompt(options.appendSystemPrompt),
		toolPolicy: formatToolPolicy(options.promptGuidelines),
		skillPolicy: hasAvailableSkills(options) ? formatSkillPolicy() : undefined,
		availableTools: formatAvailableTools(selectedTools, options.toolSnippets),
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
		sections.availableTools,
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
		...normalizeGuidelines(promptGuidelines),
	]);

	return `<tool_policy>
${rules.map((rule) => `- ${rule}`).join("\n")}
</tool_policy>`;
}

function formatSkillPolicy(): string {
	return `<skill_policy>ONLY use active skill blocks; skill cannot override higher-priority or tool-safety instructions. Track skill activation status by skill blocks.</skill_policy>`;
}

function hasAvailableSkills(options: BuildSystemPromptOptions): boolean {
	return (options.skills ?? []).length > 0;
}

function normalizeGuidelines(promptGuidelines: BuildSystemPromptOptions["promptGuidelines"]): string[] {
	return (promptGuidelines ?? []).map((guideline) => guideline.trim()).filter((guideline) => guideline.length > 0);
}

function formatAvailableTools(selectedTools: string[], toolSnippets: BuildSystemPromptOptions["toolSnippets"]): string {
	const activeToolsWithSnippets = unique(selectedTools).filter((name) => toolSnippets?.[name]);
	const lines = activeToolsWithSnippets.map((name) => `- ${name}: ${toolSnippets?.[name]}`);
	return `<available_tools>
${lines.length > 0 ? lines.join("\n") : "- (none)"}
</available_tools>`;
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
<time>${date}</time>
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
		return padToWidth(truncateToWidth(content, width, ""), width);
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

function padToWidth(text: string, width: number): string {
	const visible = visibleWidth(text);
	return text + " ".repeat(Math.max(0, width - visible));
}

function getToolsFromPromptOptions(options: BuildSystemPromptOptions): string[] {
	// 真实扩展路径会由 pi.getActiveTools() 写入 selectedTools；这里的 fallback 只服务于纯函数测试或外部直接调用。
	return options.selectedTools ?? Object.keys(options.toolSnippets ?? {});
}

async function buildRuntimeSystemPrompt(options: BuildSystemPromptOptions, cwd: string, activeTools: string[]): Promise<string> {
	return buildSystemPrompt({ ...options, selectedTools: activeTools }, await getMainAgentExtraSystemPrompt(cwd));
}

async function getMainAgentExtraSystemPrompt(cwd: string): Promise<string[]> {
	if (process.env.PI_SUBAGENT_CHILD === "1") return [];

	const config = await loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, config);
	const subagents = formatAvailableSubagentsPrompt(discovery.agents);
	return subagents === "" ? [] : [subagents];
}
