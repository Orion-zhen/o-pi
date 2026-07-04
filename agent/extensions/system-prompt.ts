import type { BuildSystemPromptOptions, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "../../src/subagent/agents.js";
import { loadSubagentConfig } from "../../src/subagent/config.js";
import type { AgentDefinition } from "../../src/subagent/types.js";

const DEFAULT_TOOLS = ["ls", "read", "find", "grep", "edit", "websearch", "webfetch", "bash"];
const SYSTEM_COMMAND_DESCRIPTION = "Show the current synthesized system prompt.";

/** 构建 system prompt；保留 Pi 默认信息来源，但不输出 skill 元数据。 */
export function buildSystemPrompt(options: BuildSystemPromptOptions, extraSections: string[] = []): string {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const cwd = options.cwd.replace(/\\/g, "/");
	const contextFiles = options.contextFiles ?? [];
	const appendSystemPrompt = options.appendSystemPrompt ? normalizeLineEndings(options.appendSystemPrompt).trim() : undefined;

	if (options.customPrompt) {
		return formatCustomPrompt(normalizeLineEndings(options.customPrompt), appendSystemPrompt, formatProjectContext(contextFiles), extraSections, date, cwd);
	}

	const tools = options.selectedTools ?? DEFAULT_TOOLS;
	return formatDefaultPrompt(
		formatTools(tools, options.toolSnippets),
		formatToolGuidelines(tools, options.promptGuidelines),
		appendSystemPrompt,
		formatProjectContext(contextFiles),
		extraSections,
		date,
		cwd,
	);
}

function formatDefaultPrompt(
	tools: string,
	toolGuidelines: string,
	appendSystemPrompt: string | undefined,
	projectContext: string | undefined,
	extraSections: string[],
	date: string,
	cwd: string,
): string {
	return joinSections([
		`<role>You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.</role>`,
		/** 工具定义 */
		`<tools>
${tools}
</tools>`,
		/** 工具使用规范 */
		`<tool_guidelines>
${toolGuidelines}
</tool_guidelines>`,
		appendSystemPrompt
			? `<append_system_prompt>
${appendSystemPrompt}
</append_system_prompt>`
			: undefined,
		projectContext,
		...extraSections,
		formatContext(date, cwd),
	]);
}

function formatCustomPrompt(
	customPrompt: string,
	appendSystemPrompt: string | undefined,
	projectContext: string | undefined,
	extraSections: string[],
	date: string,
	cwd: string,
): string {
	return joinSections([
		`<custom_prompt>
${customPrompt}
</custom_prompt>`,
		appendSystemPrompt
			? `<append_system_prompt>
${appendSystemPrompt}
</append_system_prompt>`
			: undefined,
		projectContext,
		...extraSections,
		formatContext(date, cwd),
	]);
}

/** 主 Agent 可见的精简 subagent 索引；只暴露选择所需信息。 */
export function formatAvailableSubagentsPrompt(agents: AgentDefinition[]): string {
	if (agents.length === 0) return "";
	const lines = ["<subagents>"];
	for (const agent of agents) {
		lines.push(`- ${agent.name}: ${agent.description}`);
	}
	lines.push("</subagents>");
	return lines.join("\n");
}

/** 子 Agent 专属追加提示；正文被放入 XML 标签以明确当前运行身份。 */
export function formatSubagentSystemPrompt(agent: AgentDefinition): string {
	return [
		`<subagent_context name="${escapeXml(agent.name)}">`,
		`description: ${agent.description}`,
		"role: isolated subagent",
		"Use only the tools made available in this child process.",
		"",
		"<subagent_instructions>",
		normalizeLineEndings(agent.systemPrompt),
		"</subagent_instructions>",
		"</subagent_context>",
	].join("\n");
}

function formatTools(selectedTools: string[], toolSnippets: BuildSystemPromptOptions["toolSnippets"]): string {
	const visibleTools = selectedTools.filter((name) => toolSnippets?.[name]);
	return visibleTools.length > 0
		? [
				...visibleTools.map((name) => `- ${name}: ${toolSnippets?.[name]}`),
			].join("\n")
		: "(none)";
}

function formatToolGuidelines(selectedTools: string[], promptGuidelines: BuildSystemPromptOptions["promptGuidelines"]): string {
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const add = (guideline: string) => {
		const normalized = guideline.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		guidelines.push(normalized);
	};

	if (selectedTools.includes("bash") && !selectedTools.includes("grep") && !selectedTools.includes("find") && !selectedTools.includes("ls")) {
		add("Use bash for file operations like ls, rg, find");
	}
	for (const guideline of promptGuidelines ?? []) add(guideline);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");

	return guidelines.map((guideline) => `- ${guideline}`).join("\n");
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
Project-specific instructions and guidelines:

${files}
</project_context>`;
}

function formatContext(date: string, cwd: string): string {
	return `<context>
<time>${date}</time>
<workspace>${escapeXml(cwd)}</workspace>
</context>`;
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

/** 只读滚动查看 system prompt；仅存在于 custom UI 生命周期，不写入会话历史。 */
export class SystemPromptViewer implements Component {
	private scrollTop = 0;

	constructor(
		content: string,
		private readonly theme: Theme,
		private readonly getRows: () => number,
		private readonly done: () => void,
	) {
		this.content = normalizeLineEndings(content);
	}

	private readonly content: string;

	handleInput(data: string): void {
		const pageSize = this.getBodyHeight();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
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

		const innerWidth = width;
		const bodyWidth = Math.max(1, innerWidth);
		const bodyLines = this.formatBody(bodyWidth);
		const bodyHeight = this.getBodyHeight();
		const maxScrollTop = Math.max(0, bodyLines.length - bodyHeight);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScrollTop);

		const visibleBody = bodyLines.slice(this.scrollTop, this.scrollTop + bodyHeight);
		while (visibleBody.length < bodyHeight) visibleBody.push("");

		const rawLineCount = this.content.split("\n").length;
		const title = this.theme.bold(`System prompt (${this.content.length} chars, ${rawLineCount} lines)`);
		const position = bodyLines.length > bodyHeight ? ` ${this.scrollTop + 1}-${Math.min(bodyLines.length, this.scrollTop + bodyHeight)}/${bodyLines.length}` : "";

		return [
			this.line(this.theme.fg("accent", title) + this.theme.fg("dim", position), innerWidth),
			this.line(this.theme.fg("dim", "Read-only view. Up/Down/Page/Home/End scroll, Esc/q/Enter closes."), innerWidth),
			this.line("", innerWidth),
			...visibleBody.map((line) => this.line(line, innerWidth)),
		];
	}

	invalidate(): void {}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	private getBodyHeight(): number {
		return Math.max(1, Math.floor(this.getRows() * 0.75) - 5);
	}

	private formatBody(width: number): string[] {
		const lines = this.content.split("\n");
		const numberWidth = String(lines.length).length;
		const textWidth = Math.max(1, width - numberWidth - 3);
		const formatted: string[] = [];

		lines.forEach((line, index) => {
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

	private line(content: string, width: number): string {
		return padToWidth(truncateToWidth(content, width, ""), width);
	}
}

function wrapByColumns(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;

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

/** 注册 /system 命令，用只读浮层查看当前 system prompt，不进入历史上下文。 */
export function registerSystemCommand(pi: Pick<ExtensionAPI, "registerCommand"> & Partial<Pick<ExtensionAPI, "getActiveTools">>): void {
	pi.registerCommand("system", {
		description: SYSTEM_COMMAND_DESCRIPTION,
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") return;
			const prompt = await buildRuntimeSystemPrompt(ctx.getSystemPromptOptions(), ctx.cwd, getActiveTools(pi));
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new SystemPromptViewer(prompt, theme, () => tui.terminal.rows, done),
			);
		},
	});
}

/** 在每轮开始前接管 system prompt 构建，改为 XML 风格并移除 skill 列表。 */
export default function systemPrompt(pi: ExtensionAPI): void {
	registerSystemCommand(pi);
	pi.on("before_agent_start", async (event, ctx) => ({
		systemPrompt: await buildRuntimeSystemPrompt(event.systemPromptOptions, ctx.cwd, getActiveTools(pi)),
	}));
}

function getActiveTools(pi: Partial<Pick<ExtensionAPI, "getActiveTools">>): string[] {
	return pi.getActiveTools?.() ?? DEFAULT_TOOLS;
}

async function buildRuntimeSystemPrompt(options: BuildSystemPromptOptions, cwd: string, activeTools: string[]): Promise<string> {
	return buildSystemPrompt(options, await getMainAgentExtraSystemPrompt(cwd, activeTools));
}

async function getMainAgentExtraSystemPrompt(cwd: string, activeTools: string[]): Promise<string[]> {
	if (process.env.PI_SUBAGENT_CHILD === "1") return [];
	const config = await loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, config);
	const subagents = formatAvailableSubagentsPrompt(discovery.agents);
	return subagents === "" ? [] : [subagents];
}
