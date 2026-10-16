import { buildSessionProjection, convertToLlm, type BuildSystemPromptOptions, type ContextUsage, type SessionEntry, type ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { countContentTokens, countTextTokens, type TokenCounterScope } from "../token-counter.ts";
import type { ContextBreakdownItem, ContextStats } from "./types.ts";
import { SKILL_CONTEXT_MESSAGE } from "../skill-context/types.ts";

export interface ContextBreakdownInput {
	usage: ContextUsage | undefined;
	systemPrompt?: string;
	systemPromptOptions?: BuildSystemPromptOptions;
	activeTools: string[];
	allTools?: ToolInfo[];
	branchEntries: SessionEntry[];
	model: Model<Api> | undefined;
}

/** 基于 Pi 公开 session/context 数据生成当前请求窗口的估算拆分。 */
export async function buildContextBreakdown(input: ContextBreakdownInput): Promise<ContextStats> {
	const totalTokens = input.usage?.tokens ?? undefined;
	const contextWindow = input.usage?.contextWindow;
	const activeTools = input.activeTools;
	const activeToolInfos = selectActiveToolInfos(input.allTools ?? [], activeTools);
	const model = input.model;
	const counter: TokenCounterScope = model ? { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl } : {};
	const systemPromptTokens = await estimateTokens(input.systemPrompt ?? "", counter);
	const toolDefinitionTokens = await estimateToolDefinitions(activeToolInfos, counter);
	const projectContext = extractTaggedSection(input.systemPrompt ?? "", "project_context");
	const projectContextTokens = projectContext
		? await estimateTokens(projectContext, counter)
		: await estimateProjectContext(input.systemPromptOptions, counter);
	const subagentTokens = await estimateTokens(extractTaggedSection(input.systemPrompt ?? "", "subagents"), counter);
	const systemTokens = clampKnown(systemPromptTokens - projectContextTokens - subagentTokens);
	const projected = buildSessionProjection(input.branchEntries).messages;
	const skillStats = await estimateSkillContext(projected, counter);
	const messages = convertToLlm(projected.filter((message) => message.role !== "custom" || message.customType !== SKILL_CONTEXT_MESSAGE));
	const messageStats = await estimateMessages(model ? transformMessages(messages, model) : messages, counter);

	const items: ContextBreakdownItem[] = [
		item("system", "system prompt", systemTokens, true, input.systemPrompt ? "runtime prompt" : undefined),
		item("tool_definitions", "tool definitions", toolDefinitionTokens, true, activeToolInfos.length > 0 ? `${activeToolInfos.length} active tools` : undefined),
		item("project_context", "project context", projectContextTokens, true, formatContextFilesNote(input.systemPromptOptions)),
		item("subagents", "subagents", subagentTokens, true, subagentTokens > 0 ? "main-agent index" : undefined),
		item("skills", "skills", skillStats.tokens, true, formatSkillContextNote(skillStats)),
		item("conversation_history", "conversation history", messageStats.historyTokens, true, `${messageStats.historyMessages} messages`),
		item("tool_calls", "tool calls", messageStats.toolCallTokens, true, messageStats.toolCalls > 0 ? `${messageStats.toolCalls} calls` : undefined),
		item("tool_outputs", "tool outputs", messageStats.toolOutputTokens, true, messageStats.toolResults > 0 ? `${messageStats.toolResults} results` : undefined),
		item("current_user", "current user input", messageStats.currentUserTokens, true, messageStats.currentUserTokens > 0 ? "latest user message" : undefined),
	].filter((entry) => (entry.tokens ?? 0) > 0);

	const knownTokens = sumTokens(items);
	const displayTotal = totalTokens ?? knownTokens;
	const unknownDelta = totalTokens !== undefined ? Math.max(0, totalTokens - knownTokens) : 0;
	if (unknownDelta > 0) items.push(item("unknown_delta", "unknown delta", unknownDelta, true, "provider overhead / estimator drift"));

	return {
		...(displayTotal > 0 ? { totalTokens: displayTotal } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(input.usage !== undefined ? { percent: input.usage.percent } : {}),
		...(contextWindow !== undefined && totalTokens !== undefined ? { remainingTokens: Math.max(0, contextWindow - totalTokens) } : {}),
		confidence: totalTokens === undefined ? "estimated" : "mixed",
		items: applyShares(items, displayTotal),
		notes: ["Context breakdown uses provider-aware tokenization where available; exact total still comes from Pi/provider usage."],
	};
}

function item(id: ContextBreakdownItem["id"], label: string, tokens: number, estimated: boolean, note?: string): ContextBreakdownItem {
	return {
		id,
		label,
		tokens: Math.max(0, Math.round(tokens)),
		estimated,
		...(note !== undefined ? { note } : {}),
	};
}

function applyShares(items: ContextBreakdownItem[], totalTokens: number): ContextBreakdownItem[] {
	if (totalTokens <= 0) return items;
	return items.map((entry) => ({ ...entry, share: ((entry.tokens ?? 0) / totalTokens) * 100 }));
}

function sumTokens(items: ContextBreakdownItem[]): number {
	return items.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
}

function clampKnown(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

async function estimateToolDefinitions(activeTools: ToolInfo[], counter: TokenCounterScope): Promise<number> {
	if (activeTools.length === 0) return 0;
	const definitions = activeTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return estimateTokens(JSON.stringify(definitions), counter);
}

async function estimateProjectContext(options: BuildSystemPromptOptions | undefined, counter: TokenCounterScope): Promise<number> {
	return estimateTokens((options?.contextFiles ?? []).map(({ path, content }) => `${path}\n${content}`).join("\n\n"), counter);
}

function formatContextFilesNote(options: BuildSystemPromptOptions | undefined): string | undefined {
	const files = options?.contextFiles ?? [];
	if (files.length === 0) return undefined;
	if (files.length === 1) return files[0]?.path;
	return `${files.length} context files`;
}

interface SkillEstimate {
	tokens: number;
	disclosures: number;
}

async function estimateSkillContext(context: AgentMessage[], counter: TokenCounterScope): Promise<SkillEstimate> {
	let tokens = 0;
	let disclosures = 0;
	for (const message of context) {
		if (message.role !== "custom" || message.customType !== SKILL_CONTEXT_MESSAGE) continue;
		tokens += await estimateContent(message.content, counter);
		disclosures += 1;
	}
	return { tokens, disclosures };
}

function formatSkillContextNote(stats: SkillEstimate): string | undefined {
	if (stats.tokens <= 0) return undefined;
	return `${stats.disclosures} manual disclosures`;
}

function extractTaggedSection(text: string, tag: string): string {
	const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "i");
	return text.match(pattern)?.[0] ?? "";
}

function selectActiveToolInfos(allTools: ToolInfo[], activeToolNames: string[]): ToolInfo[] {
	const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
	return activeToolNames.map((name) => toolsByName.get(name)).filter((tool): tool is ToolInfo => tool !== undefined);
}

interface MessageEstimate {
	historyTokens: number;
	historyMessages: number;
	toolCallTokens: number;
	toolCalls: number;
	toolOutputTokens: number;
	toolResults: number;
	currentUserTokens: number;
}

async function estimateMessages(messages: Message[], counter: TokenCounterScope): Promise<MessageEstimate> {
	let historyTokens = 0;
	let historyMessages = 0;
	let toolCallTokens = 0;
	let toolCalls = 0;
	let toolOutputTokens = 0;
	let toolResults = 0;
	let currentUserTokens = 0;
	const latestUser = messages.findLast((message) => message.role === "user");

	for (const message of messages) {
		if (message.role === "user") {
			const tokens = await estimateContent(message.content, counter);
			if (message === latestUser) currentUserTokens += tokens;
			else {
				historyTokens += tokens;
				historyMessages += 1;
			}
		} else if (message.role === "assistant") {
			const stats = await estimateAssistant(message, counter);
			historyTokens += stats.textTokens;
			historyMessages += 1;
			toolCallTokens += stats.toolCallTokens;
			toolCalls += stats.toolCalls;
		} else if (message.role === "toolResult") {
			toolOutputTokens += await estimateToolResult(message, counter);
			toolResults += 1;
		}
	}

	return { historyTokens, historyMessages, toolCallTokens, toolCalls, toolOutputTokens, toolResults, currentUserTokens };
}

async function estimateAssistant(message: AssistantMessage, counter: TokenCounterScope): Promise<{ textTokens: number; toolCallTokens: number; toolCalls: number }> {
	let textTokens = 0;
	let toolCallTokens = 0;
	let toolCalls = 0;
	for (const part of message.content) {
		if (part.type === "text") textTokens += await estimateTokens(part.text, counter);
		else if (part.type === "thinking") textTokens += await estimateTokens(part.thinking, counter);
		else if (part.type === "toolCall") {
			toolCalls += 1;
			toolCallTokens += await estimateTokens(`${part.name} ${JSON.stringify(part.arguments)}`, counter);
		}
	}
	return { textTokens, toolCallTokens, toolCalls };
}

async function estimateToolResult(message: ToolResultMessage, counter: TokenCounterScope): Promise<number> {
	return estimateTokens(`${message.toolName}\n${contentToText(message.content)}`, counter);
}

async function estimateContent(content: string | Array<TextContent | ImageContent>, counter: TokenCounterScope): Promise<number> {
	return (await countContentTokens(content, counter)).tokens;
}

function contentToText(content: Array<TextContent | ImageContent>): string {
	return content.map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType} ${part.data.length} chars]`)).join("\n");
}

/** provider-aware token 估算入口；测试和 breakdown 共用。 */
export async function estimateTokens(text: string, counter: TokenCounterScope = {}): Promise<number> {
	return (await countTextTokens(text, counter)).tokens;
}
