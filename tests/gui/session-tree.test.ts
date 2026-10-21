import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { SessionManager, type CustomMessageEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/harness/skill-context/types.ts";
import { formatSkillDisclosure } from "../../src/harness/skill-context/executor.ts";
import { sessionTree } from "../../src/gui/messages.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";
import { GuiHistory } from "../../src/gui/host/projection/history.ts";
import { assistant, call, result } from "./transcript-fixtures.ts";
import { SessionTree } from "../../src/gui/ui/sessions/session-tree.tsx";
import { renderWithMemory } from "./render.ts";

const body = "先检查任务范围。";
const skill: CustomMessageEntry<SkillLoadDetails> = {
	type: "custom_message", id: "skill-entry", parentId: null, timestamp: "2026-09-20T00:00:00.000Z",
	customType: SKILL_CONTEXT_MESSAGE, display: true, content: formatSkillDisclosure("development", body),
	details: { name: "development", root: "skill://development", scope: "user", loadedBy: "manual", contentHash: "hash", deduplicated: false, chars: body.length },
};

function render(entry: SessionEntry) {
	const manager = SessionManager.inMemory("/workspace", undefined, [{ type: "session", id: "fixture", version: 3, cwd: "/workspace", timestamp: entry.timestamp }, entry]);
	const history = new GuiHistory(new GuiPayloads()).project(manager);
	return parseHTML(renderWithMemory(createElement(SessionTree, {
		value: sessionTree(history.entries, entry.id), send: async () => true, locate() {},
	}))).document;
}

describe("会话树遍历", () => {
	it("长会话隐藏工具往返，保留用户消息和最终回复", () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({ role: "user", content: "检查项目", timestamp: 0 });
		for (let index = 0; index < 1_100; index++) {
			const id = `read-${index}`;
			manager.appendMessage(assistant([{ ...call, id }]));
			manager.appendMessage({ ...result, toolCallId: id });
		}
		const answerId = manager.appendMessage(assistant([{ type: "text", text: "检查完成" }], "stop"));
		const tree = sessionTree(new GuiHistory(new GuiPayloads()).project(manager).entries, manager.getLeafId());
		expect(tree.map((node) => node.entry.id)).toEqual([userId]);
		expect(tree[0]?.children.map((node) => node.entry.id)).toEqual([answerId]);
		expect(tree[0]?.children[0]?.children).toEqual([]);
	});

	it("切换回旧分支后保留两条分支，工具结果后的回复归属原用户消息", () => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({ role: "user", content: "检查项目", timestamp: 0 });
		manager.appendMessage(assistant([call]));
		manager.appendMessage(result);
		const first = manager.appendMessage(assistant([{ type: "text", text: "原分支回复" }], "stop"));
		manager.branch(userId);
		const second = manager.appendMessage(assistant([{ type: "text", text: "新分支回复" }], "stop"));
		manager.branch(first);
		const tree = sessionTree(new GuiHistory(new GuiPayloads()).project(manager).entries, manager.getLeafId());
		expect(tree.map((node) => node.entry.id)).toEqual([userId]);
		expect(tree[0]?.children.map((node) => node.entry.id)).toEqual([first, second]);
	});
});

it("多层分叉的连线和后续兄弟节点保持原有位置", () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage({ role: "user", content: "分支起点", timestamp: 0 });
	const append = (text: string) => manager.appendMessage(assistant([{ type: "text", text }], "stop"));
	const first = append("第一分支");
	append("第一个子分支");
	manager.branch(first);
	append("第二个子分支");
	manager.branch(root);
	append("第二分支");
	manager.branch(root);
	append("第三分支");
	const value = sessionTree(new GuiHistory(new GuiPayloads()).project(manager).entries, manager.getLeafId());
	const document = parseHTML(renderWithMemory(createElement(SessionTree, { value, send: async () => true, locate() {} }))).document;
	const graphs = [...document.querySelectorAll(".tree-graph")];
	expect(graphs.map((graph) => graph.getAttribute("width"))).toEqual(["18", "46", "60", "46", "32", "18"]);
	expect(graphs.map((graph) => graph.querySelectorAll('path[d$="0V32"]').length)).toEqual([0, 2, 3, 2, 1, 0]);
	expect([...graphs[0]?.querySelectorAll("path") ?? []].map((line) => line.getAttribute("d")))
		.toEqual(["M9 16L37 32", "M9 16L23 32", "M9 16L9 32"]);
});

describe("会话树技能消息", () => {
	it("隐藏 system、usage 和 context_edit 节点，不隐藏被上下文删除的原始消息", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "private instructions", timestamp: 0 });
		const usage = assistant([]).usage;
		manager.appendUsage("cache_warm", "test", "test", usage);
		const userId = manager.appendMessage({ role: "user", content: "继续", timestamp: 1 });
		manager.appendContextEdit(userId, null);
		const tree = sessionTree(new GuiHistory(new GuiPayloads()).project(manager).entries, manager.getLeafId());
		expect(tree).toHaveLength(1);
		expect(tree[0]?.entry.id).toBe(userId);
		expect(tree[0]?.children).toEqual([]);
	});

	it("标题和图标表达技能，摘要只显示名称与引用方式", () => {
		const doc = render(skill);
		expect(doc.toString()).not.toContain("invoked_skill");
		expect(doc.toString()).not.toContain(body);
		expect([...doc.querySelectorAll(".tree-row-actions button")].map((button) => button.getAttribute("aria-label")))
			.toEqual(["切换到此处", "总结后切换", "创建分支", "编辑标签"]);
	});

	it("重复加载使用去重状态，不显示空正文或协议标签", () => {
		const doc = render({ ...skill, content: formatSkillDisclosure("development", ""), details: { ...skill.details, deduplicated: true, chars: 0 } });
		expect(doc.toString()).not.toContain("invoked_skill");
	});

	it("其他扩展仍保留原始标题和摘要", () => {
		const doc = render({ ...skill, customType: "index-status", content: "索引已更新。", details: { status: "completed" } });
		expect(doc.querySelector(".tree-message-preview")?.textContent).toBe("索引已更新。");
	});
});
