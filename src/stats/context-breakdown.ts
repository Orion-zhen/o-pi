import type { BuildSystemPromptOptions, ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { countContentTokens, countTextTokens, type TokenCounterScope } from "../token-counter.js";
import type { ContextBreakdownItem, ContextStats } from "./types.js";
import { collectInjectedSkillContextTexts } from "../skill-context/context.js";
import { computeSkillContextState } from "../skill-context/state.js";
import { SKILL_CONTEXT_STATUS_MESSAGE } from "../skill-context/types.js";

export interface ContextBreakdownInput {
	usage: ContextUsage | undefined;
	systemPrompt?: string;
	systemPromptOptions?: BuildSystemPromptOptions;
	activeTools: string[];
	branchEntries: SessionEntry[];
	tokenCounter?: TokenCounterScope;
}

/** 基于 Pi 公开 session/context 数据生成当前请求窗口的估算拆分。 */
export async function buildContextBreakdown(input: ContextBreakdownInput): Promise<ContextStats> {
	const totalTokens = input.usage?.tokens ?? undefined;
	const contextWindow = input.usage?.contextWindow;
	const activeTools = input.activeTools.length > 0 ? input.activeTools : getToolsFromPromptOptions(input.systemPromptOptions);
	const counter = input.tokenCounter ?? {};
	const systemPromptTokens = await estimateTokens(input.systemPrompt ?? "", counter);
	const toolDefinitionTokens = await estimateToolDefinitions(input.systemPromptOptions, activeTools, counter);
	const projectContextTokens = await estimateProjectContext(input.systemPromptOptions, counter);
	const subagentTokens = await estimateTokens(extractTaggedSection(input.systemPrompt ?? "", "subagents"), counter);
	const systemTokens = clampKnown(systemPromptTokens - toolDefinitionTokens - projectContextTokens - subagentTokens);
	const skillStats = await estimateSkillContext(input.branchEntries, counter);
	const messageStats = await estimateMessages(input.branchEntries, counter);

	const items: ContextBreakdownItem[] = [
		item("system", "system prompt", systemTokens, true, input.systemPrompt ? "runtime prompt" : undefined),
		item("tool_definitions", "tool definitions", toolDefinitionTokens, true, activeTools.length > 0 ? `${activeTools.length} active tools` : undefined),
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
		notes: [
			"Context breakdown uses provider-aware tokenization where available; exact total still comes from Pi/provider usage.",
			"Lazy-cleared skills may remain in context until hard clear/compaction.",
		],
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

async function estimateToolDefinitions(options: BuildSystemPromptOptions | undefined, activeTools: string[], counter: TokenCounterScope): Promise<number> {
	const snippets = options?.toolSnippets ?? {};
	const text = activeTools.map((name) => `${name}: ${snippets[name] ?? ""}`).join("\n");
	return estimateTokens(text, counter);
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
	active: number;
	retainedInactive: number;
}

async function estimateSkillContext(entries: SessionEntry[], counter: TokenCounterScope): Promise<SkillEstimate> {
	const state = computeSkillContextState(entries);
	const text = collectInjectedSkillContextTexts(entries).join("\n");

	return {
		tokens: await estimateTokens(text.trim(), counter),
		active: state.active.length,
		retainedInactive: state.retained.filter((skill) => !state.active.some((active) => active.name === skill.name)).length,
	};
}

function formatSkillContextNote(stats: SkillEstimate): string | undefined {
	if (stats.tokens <= 0) return undefined;
	return `${stats.active} active, ${stats.retainedInactive} retained`;
}

function extractTaggedSection(text: string, tag: string): string {
	const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "i");
	return text.match(pattern)?.[0] ?? "";
}

function getToolsFromPromptOptions(options: BuildSystemPromptOptions | undefined): string[] {
	return options?.selectedTools ?? Object.keys(options?.toolSnippets ?? {});
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

async function estimateMessages(entries: SessionEntry[], counter: TokenCounterScope): Promise<MessageEstimate> {
	let historyTokens = 0;
	let historyMessages = 0;
	let toolCallTokens = 0;
	let toolCalls = 0;
	let toolOutputTokens = 0;
	let toolResults = 0;
	let currentUserTokens = 0;
	let latestUserEntryId: string | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") latestUserEntryId = entry.id;
	}

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (entry.customType === SKILL_CONTEXT_STATUS_MESSAGE) continue;
			historyTokens += await estimateContent(entry.content, counter);
			historyMessages += 1;
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role === "user") {
			const tokens = await estimateContent(message.content, counter);
			if (entry.id === latestUserEntryId) currentUserTokens += tokens;
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
