import { describe, expect, it } from "vitest";
import { SessionViews } from "../../src/gui/ui/session-views.ts";
import { sessionList } from "../../src/gui/ui/session-list.ts";
import type { SessionActivity } from "../../src/gui/ui/use-session-activity.ts";

describe("会话视图记忆", () => {
	it("切换后复用草稿、附件、折叠状态和阅读位置", () => {
		const views = new SessionViews();
		const a = views.open({ id: "a", path: "/a.jsonl" });
		const image = { id: 1, data: "image", mimeType: "image/png" as const };
		views.update(a, (draft) => ({ ...draft, text: "草稿 A", images: [image] }));
		a.disclosures.set("reply-a", true);
		a.position = { top: 120, follow: false };
		views.open({ id: "b", path: null });
		const again = views.open({ id: "a", path: "/a.jsonl" });
		expect(again).toBe(a);
		expect(again.draft).toMatchObject({ text: "草稿 A", images: [image] });
		expect(again.disclosures.get("reply-a")).toBe(true);
		expect(again.position).toEqual({ top: 120, follow: false });
	});
	it("实际删除后迟到上传和发送失败不能恢复记录或修改重新打开的记录", () => {
		const views = new SessionViews();
		const original = views.open({ id: "a", path: "/a.jsonl" });
		const failedSend = () => views.update(original, (draft) => ({ ...draft, text: "失败后恢复草稿" }));
		const upload = () => views.update(original, (draft) => ({ ...draft, images: [{ id: 1, data: "image", mimeType: "image/png" }] }));
		expect(views.remove({ type: "sessionsDeleted", ids: ["a"], paths: ["/a.jsonl"] })).toEqual(["a"]);
		expect(failedSend()).toBe(false);
		expect(views.get("a")).toBeUndefined();
		const reopened = views.open({ id: "a", path: "/a.jsonl" });
		expect(upload()).toBe(false);
		expect(reopened.draft).toMatchObject({ text: "", images: [] });
	});
	it("后端重启后仍能按实际删除路径清理，未删除的会话保持原记录", () => {
		const views = new SessionViews();
		views.open({ id: "a", path: "/a.jsonl" });
		const b = views.open({ id: "b", path: "/b.jsonl" });
		expect(views.remove({ type: "sessionsDeleted", ids: [], paths: ["/a.jsonl"] })).toEqual(["a"]);
		expect(views.get("a")).toBeUndefined();
		expect(views.get("b")).toBe(b);
	});
});

describe("统一会话列表", () => {
	it("冷历史使用路径打开，已登记和未落盘会话使用 ID，不重复列出同一路径", () => {
		const history = [
			{ path: "/cold.jsonl", cwd: "/project", title: "冷历史", modified: "2026-09-18" },
			{ path: "/warm.jsonl", cwd: "/project", title: "旧标题", modified: "2026-09-19" },
		];
		const activity: SessionActivity[] = [
			{ sessionId: "warm", path: "/warm.jsonl", cwd: "/project", title: "新标题", state: "idle", completedAt: 0, unread: false },
			{ sessionId: "empty", path: null, cwd: "/project", title: "未落盘", state: "idle", completedAt: 0, unread: false },
		];
		const rows = sessionList(history, activity, "empty");
		expect(rows).toHaveLength(3);
		expect(rows.find((row) => row.path === "/cold.jsonl")).toMatchObject({ target: { path: "/cold.jsonl" }, selected: false });
		expect(rows.find((row) => row.path === "/warm.jsonl")).toMatchObject({ target: { id: "warm" }, title: "新标题" });
		expect(rows.find((row) => row.path === null)).toMatchObject({ target: { id: "empty" }, selected: true });
	});
	it("未命名旧会话保留历史派生标题，未落盘新会话显示新会话", () => {
		const history = [
			{ path: "/old.jsonl", cwd: "/project", title: "旧会话首条消息", modified: "2026-09-18" },
		];
		const activity: SessionActivity[] = [
			{ sessionId: "old", path: "/old.jsonl", cwd: "/project", title: "", state: "idle", completedAt: 0, unread: false },
			{ sessionId: "fresh", path: "/fresh.jsonl", cwd: "/project", title: "", state: "idle", completedAt: 0, unread: false },
		];
		const rows = sessionList(history, activity, "old");
		expect(rows.find((row) => row.path === "/old.jsonl")).toMatchObject({ title: "旧会话首条消息" });
		expect(rows.find((row) => row.path === "/fresh.jsonl")).toMatchObject({ title: "新会话" });
	});
});
