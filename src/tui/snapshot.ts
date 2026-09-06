import type { UserMessage } from "@earendil-works/pi-ai";
import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectSkillSummary } from "../skill-context/loader.js";
import { summarizeUsage } from "../stats/usage.js";
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
	return collectSkillSummary(pi.getCommands());
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
	const { usage, cache } = summarizeUsage(ctx.sessionManager.getEntries()
		.flatMap((entry) => entry.type === "message" ? [entry.message] : []));
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } = usage;
	const { latestHitRate: latestCacheHitRate, totalHitRate: totalCacheHitRate } = cache;
	return {
		...(inputTokens > 0 ? { inputTokens } : {}),
		...(outputTokens > 0 ? { outputTokens } : {}),
		...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
		...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
		...(latestCacheHitRate !== undefined ? { latestCacheHitRate } : {}),
		...(totalCacheHitRate !== undefined ? { totalCacheHitRate } : {}),
		...(costUsd === undefined ? {} : { costUsd }),
	};
}
