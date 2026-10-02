import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { SessionManager, type CustomMessageEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/harness/skill-context/types.ts";
import { formatSkillDisclosure } from "../../src/harness/skill-context/executor.ts";
import { sessionTree } from "../../src/gui/messages.ts";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import { GuiHistory } from "../../src/gui/host/history.ts";
import { assistant } from "./transcript-fixtures.ts";
import { SessionTree } from "../../src/gui/ui/sessions/session-tree.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
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
	return parseHTML(renderWithMemory(createElement(TooltipProvider, null, createElement(SessionTree, {
		value: sessionTree(history.entries, entry.id), send: async () => true, locate() {},
	})))).document;
}

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
