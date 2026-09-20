import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { SessionManager, type CustomMessageEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "../../src/harness/skill-context/types.ts";
import { formatSkillDisclosure } from "../../src/harness/skill-context/executor.ts";
import { filterSessionTreeNoTools } from "../../src/gui/host/session-tree.ts";
import { assistant } from "./transcript-fixtures.ts";
import { SessionTree } from "../../src/gui/ui/session-tree.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { renderWithMemory } from "./render.ts";

const body = "先检查任务范围。";
const skill: CustomMessageEntry<SkillLoadDetails> = {
	type: "custom_message", id: "skill-entry", parentId: null, timestamp: "2026-09-20T00:00:00.000Z",
	customType: SKILL_CONTEXT_MESSAGE, display: true, content: formatSkillDisclosure("development", body),
	details: { name: "development", root: "skill://development", scope: "user", loadedBy: "manual", contentHash: "hash", deduplicated: false, chars: body.length },
};

function render(entry: SessionEntry) {
	return parseHTML(renderWithMemory(createElement(TooltipProvider, null, createElement(SessionTree, {
		value: [{ entry, children: [] }], send: async () => true, locate() {},
	})))).document;
}

describe("会话树技能消息", () => {
	it("隐藏 system 和 usage 节点，同时保留后续用户消息", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "private instructions", timestamp: 0 });
		const usage = assistant([]).usage;
		manager.appendUsage("cache_warm", "test", "test", usage);
		const userId = manager.appendMessage({ role: "user", content: "继续", timestamp: 1 });
		const tree = filterSessionTreeNoTools(manager.getTree(), manager.getLeafId());
		expect(tree).toHaveLength(1);
		expect(tree[0]?.entry.id).toBe(userId);
		expect(tree[0]?.children).toEqual([]);
	});

	it("标题和图标表达技能，摘要只显示名称与引用方式", () => {
		const doc = render(skill);
		expect(doc.querySelector(".tree-role")?.textContent).toBe("技能");
		expect(doc.querySelector(".tree-role svg")).not.toBeNull();
		expect(doc.querySelector(".tree-message-preview")?.textContent).toBe("development · 手动引用");
		expect(doc.querySelector(".tree-message-preview")?.getAttribute("title")).toBe("development · 手动引用");
		expect(doc.toString()).not.toContain("invoked_skill");
		expect(doc.toString()).not.toContain(body);
		expect(doc.querySelector(".tree-jump")?.getAttribute("aria-label")).toBe(`定位消息 ${skill.id}`);
		expect([...doc.querySelectorAll(".tree-row-actions button")].map((button) => button.getAttribute("aria-label")))
			.toEqual(["切换到此处", "总结后切换", "创建分支", "编辑标签"]);
	});

	it("重复加载使用去重状态，不显示空正文或协议标签", () => {
		const doc = render({ ...skill, content: formatSkillDisclosure("development", ""), details: { ...skill.details, deduplicated: true, chars: 0 } });
		expect(doc.querySelector(".tree-role")?.textContent).toBe("技能");
		expect(doc.querySelector(".tree-message-preview")?.textContent).toBe("development · 已加载过，未重复注入");
		expect(doc.toString()).not.toContain("invoked_skill");
		expect(doc.toString()).not.toContain("无消息正文");
	});

	it("其他扩展仍保留原始标题和摘要", () => {
		const doc = render({ ...skill, customType: "index-status", content: "索引已更新。", details: { status: "completed" } });
		expect(doc.querySelector(".tree-role")?.textContent).toBe("扩展消息");
		expect(doc.querySelector(".tree-role svg")).toBeNull();
		expect(doc.querySelector(".tree-message-preview")?.textContent).toBe("索引已更新。");
	});
});
