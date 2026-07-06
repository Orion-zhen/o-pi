import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildContextBreakdown, estimateTokens } from "../../src/stats/context-breakdown.js";
import { SKILL_CONTEXT_ENTRY, SKILL_CONTEXT_STATUS_MESSAGE, type SkillContextEntry } from "../../src/skill-context/types.js";

describe("stats context breakdown", () => {
	it("把 system、tools、project、history、tool output 和 delta 拆成估算项", async () => {
		const branchEntries: SessionEntry[] = [
			entry("1", user("older user message")),
			entry("2", assistantWithTool("read", { path: "src/a.ts" })),
			entry("3", toolResult("read", "tool output text", false)),
			entry("4", user("latest user input")),
		];

		const stats = await buildContextBreakdown({
			usage: { tokens: 1000, contextWindow: 4000, percent: 25 },
			systemPrompt: "<tool_policy>Use tools</tool_policy>\n<subagents>\n- scout: inspect\n</subagents>\nRules",
			systemPromptOptions: {
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: "read files" },
				contextFiles: [{ path: "AGENTS.md", content: "Project rules" }],
			},
			activeTools: ["read"],
			branchEntries,
		});

		expect(stats.confidence).toBe("mixed");
		expect(stats.totalTokens).toBe(1000);
		expect(stats.remainingTokens).toBe(3000);
		expect(stats.items.map((item) => item.id)).toContain("tool_definitions");
		expect(stats.items.map((item) => item.id)).toContain("project_context");
		expect(stats.items.map((item) => item.id)).toContain("conversation_history");
		expect(stats.items.map((item) => item.id)).toContain("tool_outputs");
		expect(stats.items.map((item) => item.id)).toContain("current_user");
		expect(stats.items.at(-1)?.id).toBe("unknown_delta");
		expect(stats.items.every((item) => item.estimated)).toBe(true);
	});

	it("没有 context usage 时使用估算总量", async () => {
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system prompt text",
			activeTools: [],
			branchEntries: [entry("1", user("hello world"))],
		});

		expect(stats.confidence).toBe("estimated");
		expect(stats.totalTokens).toBeGreaterThanOrEqual(await estimateTokens("system prompt text"));
		expect(stats.contextWindow).toBeUndefined();
	});

	it("将 lazy retained skill 计入 skills，hard cleared body 不计入", async () => {
		const lazyStats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [custom("1", activation("demo")), entry("2", user("first")), custom("3", deactivation("demo", "lazy"))],
		});
		const lazySkill = lazyStats.items.find((item) => item.id === "skills");
		expect(lazySkill?.tokens).toBeGreaterThan(0);
		expect(lazySkill?.note).toBe("0 active, 1 retained");

		const hardStats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [custom("1", activation("demo")), custom("2", deactivation("demo", "hard"))],
		});
		const hardSkill = hardStats.items.find((item) => item.id === "skills");
		expect(hardSkill?.tokens ?? 0).toBeLessThan(lazySkill?.tokens ?? 0);
		expect(hardStats.notes.some((note) => note.includes("Lazy-cleared skills"))).toBe(true);
	});

	it("conversation history 不统计 skill 状态卡片", async () => {
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [statusMessage("1"), entry("2", user("hello"))],
		});
		const history = stats.items.find((item) => item.id === "conversation_history");
		expect(history).toBeUndefined();
		expect(stats.items.find((item) => item.id === "current_user")?.tokens).toBeGreaterThan(0);
	});

	it("skills token 估算使用折叠后的连续 load/unload 结果", async () => {
		const folded = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [custom("1", activation("demo")), custom("2", deactivation("demo", "lazy")), custom("3", activation("demo"))],
		});
		const single = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [custom("1", activation("demo"))],
		});

		expect(folded.items.find((item) => item.id === "skills")?.tokens).toBe(single.items.find((item) => item.id === "skills")?.tokens);
	});
});

function entry(id: string, message: Message): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-07-05T00:00:00.000Z", message };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantWithTool(name: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "assistant text" }, { type: "toolCall", id: `${name}-1`, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolName: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}

function custom(id: string, data: SkillContextEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-07-05T00:00:00.000Z", customType: SKILL_CONTEXT_ENTRY, data };
}

function activation(name: string): SkillContextEntry {
	return {
		kind: "activation",
		name,
		description: "desc",
		path: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		body: `${name} body`,
		contentHash: "hash",
		scope: "task",
		loadedAt: "t",
	};
}

function deactivation(name: string, mode: "lazy" | "hard"): SkillContextEntry {
	return { kind: "deactivation", name, mode, reason: "user_clear", clearedAt: "t" };
}

function statusMessage(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-07-05T00:00:00.000Z",
		customType: SKILL_CONTEXT_STATUS_MESSAGE,
		content: "skill demo loaded",
		display: true,
	};
}
