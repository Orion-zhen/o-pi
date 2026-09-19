import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { WorkspacePicker } from "../../src/gui/ui/workspace-picker.tsx";
import { HistorySessionRow } from "../../src/gui/ui/history-session-row.tsx";
import { TooltipProvider } from "../../src/gui/ui/components/ui/tooltip.tsx";
import { workspaceActivity, type SessionActivity } from "../../src/gui/ui/use-session-activity.ts";

function row(busy: boolean, waiting: boolean, unread: boolean) {
	return parseHTML(renderToStaticMarkup(createElement(TooltipProvider, null, createElement(HistorySessionRow, {
		path: "/sessions/task.jsonl", title: "任务 A", selected: false, disabled: false, busy, waiting, unread,
		send: async () => true, open: () => {}, animated: false,
	})))).document;
}

function activity(sessionId: string, cwd: string, state: SessionActivity["state"], unread = false): SessionActivity {
	return { sessionId, cwd, state, unread, path: `/sessions/${sessionId}.jsonl`, title: sessionId, completedAt: unread ? 1 : 0, modified: "2026-09-19T00:00:00.000Z" };
}

describe("会话列表状态", () => {
	it.each([
		{ busy: false, waiting: false, unread: false, state: "idle", deletable: true },
		{ busy: true, waiting: false, unread: false, state: "running", deletable: false },
		{ busy: true, waiting: true, unread: false, state: "waiting", deletable: false },
		{ busy: false, waiting: false, unread: true, state: "unread", deletable: false },
		{ busy: true, waiting: false, unread: true, state: "running", deletable: false },
		{ busy: true, waiting: true, unread: true, state: "waiting", deletable: false },
	])("$state 会话的边框、审批标记和删除入口（未读=$unread）", ({ busy, waiting, unread, state, deletable }) => {
		const document = row(busy, waiting, unread);
		expect(document.querySelector(".history-session-row > .activity-border")?.getAttribute("data-activity")).toBe(state);
		expect(document.querySelector('[aria-label="删除会话 任务 A"]') !== null).toBe(deletable);
		expect(document.querySelector(".approval-marker") !== null).toBe(waiting);
		if (waiting) expect(document.querySelector(".approval-marker")?.getAttribute("fill")).toBe("currentColor");
		expect(document.querySelector(".history-session")?.hasAttribute("disabled")).toBe(false);
		expect(document.querySelector(".history-session")?.getAttribute("data-unread")).toBe(String(unread));
	});
});

describe("工作区切换边框", () => {
	it.each([
		{ items: [], state: "idle" },
		{ items: [activity("A", "/a", "running")], state: "idle" },
		{ items: [activity("B", "/b", "running")], state: "running" },
		{ items: [activity("B", "/b", "loading")], state: "running" },
		{ items: [activity("A", "/a", "idle", true), activity("B", "/b", "running")], state: "unread" },
		{ items: [activity("B", "/b", "idle", true), activity("C", "/c", "running")], state: "unread" },
		{ items: [activity("A", "/a", "waiting"), activity("B", "/b", "running")], state: "waiting" },
		{ items: [activity("B", "/b", "waiting"), activity("A", "/a", "idle", true)], state: "waiting" },
		{ items: [activity("A", "/a", "idle"), activity("B", "/b", "idle")], state: "idle" },
	])("$state: $items", ({ items, state }) => {
		for (const compact of [false, true]) {
			const document = parseHTML(renderToStaticMarkup(createElement(WorkspacePicker, {
				gui: { cwd: "/a", activity: items, workspaceRoot: "/a", workspaces: [], connected: true,
					canNavigate: true, send: async () => true, globalQuery: async () => { throw new Error("不应查询"); },
					error: "", setError: () => {} },
				close: () => {}, compact,
			}))).document;
			expect(document.querySelector(".workspace-select.activity-frame > .activity-border")?.getAttribute("data-activity")).toBe(state);
		}
	});
});

describe("工作区状态汇总", () => {
	it("仅汇总对应工作区，运行结束后仍提示其他未读会话", () => {
		const items = [activity("A", "/a", "running"), activity("B", "/a", "idle", true), activity("C", "/b", "waiting")];
		expect(workspaceActivity(items, "/a")).toBe("running");
		expect(workspaceActivity(items, "/b")).toBe("waiting");
		expect(workspaceActivity(items, "/empty")).toBe("idle");
		items[0] = activity("A", "/a", "idle");
		expect(workspaceActivity(items, "/a")).toBe("unread");
		items[1] = activity("B", "/a", "idle");
		expect(workspaceActivity(items, "/a")).toBe("idle");
	});

	it("审批优先于同工作区的运行状态，处理后恢复运行或未读提示", () => {
		const items = [activity("A", "/a", "running"), activity("B", "/a", "waiting"), activity("C", "/a", "idle", true)];
		expect(workspaceActivity(items, "/a")).toBe("waiting");
		items[0] = activity("A", "/a", "loading");
		expect(workspaceActivity(items, "/a")).toBe("waiting");
		items[1] = activity("B", "/a", "idle");
		expect(workspaceActivity(items, "/a")).toBe("running");
		items[0] = activity("A", "/a", "idle");
		expect(workspaceActivity(items, "/a")).toBe("unread");
	});

	it("加载中的会话也属于进行中，审批等待不清除未读", () => {
		expect(workspaceActivity([activity("A", "/a", "loading")], "/a")).toBe("running");
		const items = [activity("A", "/a", "waiting"), activity("B", "/a", "idle", true)];
		expect(workspaceActivity(items, "/a")).toBe("waiting");
		items[0] = activity("A", "/a", "idle");
		expect(workspaceActivity(items, "/a")).toBe("unread");
	});
});
