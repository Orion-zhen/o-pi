import path from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	loadSkillsFromDir,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { collectSkillCandidates } from "../skill-context/loader.js";
import type { TuiRunStatus, TuiSkillsSnapshot, TuiSnapshot, TuiToolsSnapshot } from "./types.js";

/** 在会话和轮次事件中采集用量，避免每次重绘都遍历会话记录。 */
export function collectSessionState(ctx: ExtensionContext, status: TuiRunStatus) {
	const model = ctx.model;
	const context = ctx.getContextUsage();
	return {
		cwd: ctx.cwd,
		status,
		...(model === undefined ? {} : {
			modelId: model.id,
			modelProvider: model.provider,
			modelReasoning: model.reasoning,
			usingSubscription: ctx.modelRegistry.isUsingOAuth(model),
		}),
		...(context === undefined ? {} : { context }),
		...collectUsage(ctx),
	};
}

export function countAvailableProviders(ctx: ExtensionContext): number {
	return new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider)).size;
}

/** 启用子集沿用注册顺序，避免 /tools 切换后列表抖动。 */
export function collectTools(pi: ExtensionAPI): TuiToolsSnapshot {
	const allNames = pi.getAllTools().map((tool) => tool.name);
	const active = new Set(pi.getActiveTools());
	return { allNames, activeNames: allNames.filter((name) => active.has(name)) };
}

/** 复用 skill 索引规则统计去重总数和模型可调用数。 */
export function collectSkills(pi: ExtensionAPI): TuiSkillsSnapshot | undefined {
	const candidates = collectSkillCandidates(undefined, pi.getCommands());
	if (candidates.length === 0) return undefined;
	const skillsByDirectory = new Map<string, Skill[]>();
	let modelInvocableCount = 0;
	for (const candidate of candidates) {
		const directory = path.dirname(candidate.path);
		let parsedSkills = skillsByDirectory.get(directory);
		if (parsedSkills === undefined) {
			parsedSkills = loadSkillsFromDir({ dir: directory, source: candidate.scope }).skills;
			skillsByDirectory.set(directory, parsedSkills);
		}
		const candidatePath = path.resolve(candidate.path);
		const parsed = parsedSkills.find((skill) => path.resolve(skill.filePath) === candidatePath);
		if (parsed !== undefined && !parsed.disableModelInvocation) modelInvocableCount += 1;
	}
	return { totalCount: candidates.length, modelInvocableCount };
}

/** 历史补齐和消息时间戳必须使用同一条可见分支。 */
export function collectUserMessages(ctx: ExtensionContext): UserMessage[] {
	return ctx.sessionManager.buildContextEntries()
		.flatMap(sessionEntryToContextMessages)
		.filter((message): message is UserMessage => message.role === "user");
}

export function userMessageText(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
}

function collectUsage(ctx: ExtensionContext): Pick<
	TuiSnapshot,
	"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "latestCacheHitRate" | "totalCacheHitRate" | "costUsd"
> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		inputTokens += usage.input;
		outputTokens += usage.output;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
		costUsd += usage.cost.total;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
	}
	const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	const totalCacheHitRate = promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : undefined;
	return {
		...(inputTokens > 0 ? { inputTokens } : {}),
		...(outputTokens > 0 ? { outputTokens } : {}),
		...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
		...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
		...(latestCacheHitRate !== undefined ? { latestCacheHitRate } : {}),
		...(totalCacheHitRate !== undefined ? { totalCacheHitRate } : {}),
		...(costUsd > 0 ? { costUsd } : {}),
	};
}
