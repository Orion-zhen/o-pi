import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { injectSkillContext } from "../../src/skill-context/context.js";
import { SKILL_CONTEXT_ENTRY, SKILL_CONTEXT_STATUS_MESSAGE, type SkillContextEntry } from "../../src/skill-context/types.js";

type ContextMessage = ContextEvent["messages"][number];

describe("skill context injection", () => {
	it("无 skill entries 时 messages 原样返回", () => {
		const messages = [user("hello")];
		expect(injectSkillContext([message("1", "hello")], messages)).toBe(messages);
	});

	it("activation entry 按 branch 位置转换为 synthetic user message，当前 user 留在最后", () => {
		const output = injectSkillContext([custom("1", activation("demo"))], [user("current task")]);
		expect(output).toHaveLength(2);
		expect(textOf(output[0])).toContain('<loaded_skill name="demo">');
		expect(textOf(output[1])).toBe("current task");
	});

	it("连续 load/unload/load 且中间没有真实消息时只注入最后 active skill", () => {
		const output = injectSkillContext([
			custom("1", activation("demo")),
			custom("2", deactivation("demo", "lazy")),
			custom("3", activation("demo")),
	], [user("next")]);
		const text = output.map(textOf).join("\n");
		expect(text.match(/<loaded_skill name="demo">/g)).toHaveLength(1);
		expect(text).not.toContain("<unload_skill");
		expect(textOf(output.at(-1))).toBe("next");
	});

	it("连续 load/unload 且中间没有真实消息时不注入 skill block", () => {
		const output = injectSkillContext([custom("1", activation("demo")), custom("2", deactivation("demo", "lazy"))], [user("next")]);
		expect(output.map(textOf)).toEqual(["next"]);
	});

	it("真实消息之后 lazy clear 保留 load_skill 并追加 unload_skill", () => {
		const output = injectSkillContext([
			custom("1", activation("demo")),
			message("2", "first"),
			custom("3", deactivation("demo", "lazy")),
			message("4", "next"),
	], [user("first"), user("next")]);
		const text = output.map(textOf).join("\n");
		expect(text).toContain('<loaded_skill name="demo">');
		expect(text).toContain('<unload_skill name="demo">');
	});

	it("真实消息之后 hard clear 省略旧 load_skill body 且不追加 unload block", () => {
		const output = injectSkillContext([
			custom("1", activation("demo")),
			message("2", "first"),
			custom("3", deactivation("demo", "hard")),
			message("4", "next"),
	], [user("first"), user("next")]);
		const text = output.map(textOf).join("\n");
		expect(text).not.toContain("demo body");
		expect(text).not.toContain("<unload_skill");
		expect(text).not.toContain("<unload_previous_skills>");
	});

	it("真实消息之后 all hard clear 省略旧 load_skill body 且不追加 unload_previous_skills", () => {
		const output = injectSkillContext([
			custom("1", activation("demo")),
			message("2", "first"),
			custom("3", deactivationAll("hard")),
			message("4", "next"),
	], [user("first"), user("next")]);
		const text = output.map(textOf).join("\n");
		expect(text).not.toContain("demo body");
		expect(text).not.toContain("<unload_previous_skills>");
	});

	it("synthetic 文本不含 loadedAt/clearedAt 动态时间", () => {
		const output = injectSkillContext([custom("1", activation("demo"))], [user("next")]);
		expect(output.map(textOf).join("\n")).not.toContain("dynamic-time");
	});

	it("状态卡片 custom_message 不进入模型上下文", () => {
		const branch: SessionEntry[] = [statusMessage("1"), message("2", "task")];
		const output = injectSkillContext(branch, [customAgentMessage("skill demo loaded"), user("task")]);
		expect(output.map(textOf)).toEqual(["task"]);
	});
});

function user(content: string): ContextMessage {
	return { role: "user", content, timestamp: 1 };
}

function message(id: string, content: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "t", message: { role: "user", content, timestamp: 1 } };
}

function custom(id: string, data: SkillContextEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}

function statusMessage(id: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "t",
		customType: SKILL_CONTEXT_STATUS_MESSAGE,
		content: "skill demo loaded",
		display: true,
	};
}

function customAgentMessage(content: string): ContextMessage {
	return { role: "custom", customType: SKILL_CONTEXT_STATUS_MESSAGE, content, display: true, timestamp: 1 };
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
		loadedAt: "dynamic-time",
	};
}

function deactivation(name: string, mode: "lazy" | "hard"): SkillContextEntry {
	return { kind: "deactivation", name, mode, reason: "user_clear", clearedAt: "dynamic-time" };
}

function deactivationAll(mode: "lazy" | "hard"): SkillContextEntry {
	return { kind: "deactivation", mode, reason: "user_clear", clearedAt: "dynamic-time" };
}

function textOf(message: ContextMessage | undefined): string {
	if (message === undefined) return "";
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
