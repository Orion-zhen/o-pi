import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuiHost } from "../../../../src/gui/host/host.ts";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import type { SessionSearchHit } from "../../../../src/gui/shared/session-search.ts";
import { preserveEnv, useTempDir } from "../../../helpers/lifecycle.ts";

const temp = useTempDir("opi-session-search-");
preserveEnv("PI_CODING_AGENT_DIR");
let host: GuiHost;
let client: GuiClient;
let cwd: string;
let directory: string;
let sequence: number;
beforeEach(async () => {
	cwd = path.join(temp.path, "project");
	process.env.PI_CODING_AGENT_DIR = path.join(temp.path, "agent");
	directory = path.join(temp.path, "agent", "sessions", "project");
	await mkdir(directory, { recursive: true });
	await mkdir(cwd);
	sequence = 0;
	host = new GuiHost(); host.workspaceRoot = cwd;
	client = host.createClient();
});
afterEach(async () => { await host.dispose(); vi.restoreAllMocks(); syncBuiltinESMExports(); });
const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
async function store(title: string, entries: unknown[], workspace = cwd) {
	const file = path.join(directory, `${sequence++}.jsonl`);
	await writeFile(file, [
		{ type: "session", cwd: workspace, timestamp: "2026-01-01T00:00:00Z" },
		{ type: "session_info", name: title }, ...entries,
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}
async function search(text: string) {
	let page = await client.query({ query: "searchSessions", cwd, text });
	const hits: SessionSearchHit[] = [...page.hits];
	while (!page.done) {
		page = await client.query({ query: "continueSessionSearch", id: page.id });
		hits.push(...page.hits);
	}
	return hits;
}

describe("会话内容搜索", () => {
	it("标题先返回，正文在同一消息内多关键词 AND，不恢复任何执行实例", async () => {
		const title = await store("中文 SEARCH 标题", []);
		const user = await store("用户记录", [message("user", "中文内容中隔着很多文字，还有 Search 关键词")]);
		const assistant = await store("助手记录", [message("assistant", [{ type: "text", text: "SEARCH 回复中的中文" }])]);
		await store("跨消息", [message("user", "中文"), message("assistant", "search")]);
		await store("另一工作区", [message("user", "中文 search")], path.join(temp.path, "other"));
		await host.catalog.refresh();
		const first = await client.query({ query: "searchSessions", cwd, text: "中文 search" });
		expect(first.hits.map((hit) => hit.path)).toEqual([title]);
		expect(first.done).toBe(false);
		const second = await client.query({ query: "continueSessionSearch", id: first.id });
		expect(second.hits.map((hit) => hit.path).sort()).toEqual([user, assistant].sort());
		expect(second.done).toBe(true);
		expect(host.sessions.size).toBe(0);
	});

	it("跨读取块、JSON 转义、扩展汉字和大小写映射保持原文高亮", async () => {
		const file = await store("正文", [message("user", "前".repeat(22_000) + "𠮷😀中文 İSTANBUL ΣΥΖΉΤΗΣΗ")]);
		await host.catalog.refresh();
		const hits = await search("𠮷😀中文 i̇stanbul συζήτηση");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.path).toBe(file);
		const excerpt = hits[0]?.excerpt;
		expect(excerpt?.text).toContain("𠮷😀中文 İSTANBUL ΣΥΖΉΤΗΣΗ");
		expect(excerpt?.ranges.map(([start, end]) => excerpt.text.slice(start, end))).toEqual(["𠮷😀中文", "İSTANBUL", "ΣΥΖΉΤΗΣΗ"]);
		const raw = '{"type":"message","message":{"content":"\\ud842\\udfb7\\ud83d\\ude00\\u4e2d\\u6587","role":"user"}}';
		await writeFile(file, JSON.stringify({ type: "session", cwd }) + "\n" + raw + "\n");
		expect(await search("𠮷😀中文")).toHaveLength(1);
	});

	it("只搜索用户和助手文本，不搜索工具、思考和图片，也不跨文本块拼接关键词", async () => {
		await store("排除工具", [message("toolResult", [{ type: "text", text: "独有词" }])]);
		await store("排除思考", [message("assistant", [{ type: "thinking", thinking: "独有词" }])]);
		await store("排除图片", [message("user", [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", mimeType: "image/png" }])]);
		await store("跨块词", [message("user", [{ type: "text", text: "独" }, { type: "text", text: "有词" }])]);
		const match = await store("助手回复", [message("assistant", [{ type: "text", text: "独有词" }])]);
		await host.catalog.refresh();
		expect((await search("独有词")).map((hit) => hit.path)).toEqual([match]);
		expect(await search("iVBORw0KGgo")).toEqual([]);
	});

	it("长正文摘要围绕首个命中截取，重叠关键词合并高亮且不受查询顺序影响", async () => {
		await store("使用文档", [message("user", "这是较长的背景说明。".repeat(100) + "会话内容搜索" + "这里是后续说明。".repeat(100) + "使用方法")]);
		await host.catalog.refresh();
		for (const text of ["使用方法 搜索 内容搜索", "内容搜索 搜索 使用方法"]) {
			const hits = await search(text);
			expect(hits).toHaveLength(1);
			const excerpt = hits[0]?.excerpt;
			expect(excerpt?.ranges.map(([start, end]) => excerpt.text.slice(start, end))).toEqual(["内容搜索"]);
			expect(excerpt?.text.length).toBeLessThan(200);
			expect(excerpt?.text.startsWith("…")).toBe(true);
			expect(excerpt?.text.endsWith("…")).toBe(true);
		}
	});

	it("关键词可以分散在同一条消息的多个文本块，损坏记录与未完成尾行不产生结果", async () => {
		const file = await store("多块", [message("user", [{ type: "text", text: "中文" }, { text: "测试", type: "text" }])]);
		const broken = await store("损坏", []);
		await fs.promises.appendFile(broken, JSON.stringify(message("user", "中文 测试")) + 'bad\n{"type":"message","message":{"role":"user","content":"中文 测试');
		await host.catalog.refresh();
		expect((await search("中文 测试")).map((hit) => hit.path)).toEqual([file]);
	});

	it("标题命中不重读正文，搜索不触发目录全量刷新", async () => {
		await store("唯一标题", [message("user", "正文")]);
		await host.catalog.refresh();
		const read = vi.spyOn(fs, "createReadStream"); syncBuiltinESMExports();
		expect(await search("唯一标题")).toHaveLength(1);
		expect(read).not.toHaveBeenCalled();
	});

	it("分批拉取不积压扫描，限制文件并发，取消后释放文件", async () => {
		for (let index = 0; index < 80; index++) await store(`标题 ${index}`, [message("user", "正文命中")]);
		await host.catalog.refresh();
		const original = fs.createReadStream;
		let active = 0, peak = 0;
		const read = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
			const stream = original(...args);
			active++; peak = Math.max(peak, active);
			stream.once("close", () => { active--; });
			return stream;
		});
		syncBuiltinESMExports();
		const first = await client.query({ query: "searchSessions", cwd, text: "正文命中" });
		expect(read).not.toHaveBeenCalled();
		const page = await client.query({ query: "continueSessionSearch", id: first.id });
		expect(page.done).toBe(false);
		expect(page.hits.length).toBeLessThanOrEqual(32);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(read.mock.calls.length).toBeLessThanOrEqual(page.scanned + 4);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
		await client.dispatch({ action: "cancelSessionSearch", id: first.id });
		expect(active).toBe(0);
	});

	it("目录快照中的文件删除后跳过，其他读取错误不伪装成无匹配", async () => {
		const file = await store("旧记录", [message("user", "正文关键词")]);
		await host.catalog.refresh();
		await fs.promises.rm(file);
		expect(await search("正文关键词")).toEqual([]);
		await mkdir(file);
		await expect(search("正文关键词")).rejects.toThrow();
	});

	it("停止拉取的任务到期后释放，不保留后台扫描", async () => {
		await store("正文", [message("user", "关键词")]);
		await host.catalog.refresh();
		vi.useFakeTimers();
		try {
			const page = await client.query({ query: "searchSessions", cwd, text: "关键词" });
			await vi.advanceTimersByTimeAsync(60_000);
			await expect(client.query({ query: "continueSessionSearch", id: page.id })).rejects.toThrow("搜索任务已结束");
		} finally { vi.useRealTimers(); }
	});

	it("等待共享文件预算的任务可以立即取消，不等待其他查询结束", async () => {
		for (let index = 0; index < 4; index++) await store(`长记录 ${index}`, [message("user", "前".repeat(500_000))]);
		await host.catalog.refresh();
		const other = host.createClient();
		const first = await client.query({ query: "searchSessions", cwd, text: "不存在" });
		const second = await other.query({ query: "searchSessions", cwd, text: "不存在" });
		let finished = false;
		const running = client.query({ query: "continueSessionSearch", id: first.id }).finally(() => { finished = true; });
		const waiting = other.query({ query: "continueSessionSearch", id: second.id });
		const rejected = expect(waiting).rejects.toThrow();
		await other.dispatch({ action: "cancelSessionSearch", id: second.id });
		await rejected;
		expect(finished).toBe(false);
		await running;
		await client.dispatch({ action: "cancelSessionSearch", id: first.id });
	});

	it("断开客户端取消在途扫描，其他客户端的任务仍然可继续", async () => {
		await store("长记录", [message("user", "前".repeat(500_000) + "目标")]);
		await host.catalog.refresh();
		const other = host.createClient();
		const first = await client.query({ query: "searchSessions", cwd, text: "不存在" });
		const second = await other.query({ query: "searchSessions", cwd, text: "目标" });
		const pending = client.query({ query: "continueSessionSearch", id: first.id });
		const rejected = expect(pending).rejects.toThrow();
		client.close();
		await rejected;
		expect((await other.query({ query: "continueSessionSearch", id: second.id })).hits).toHaveLength(1);
	});

	it("新搜索替换同客户端在途任务，旧请求和其他客户端不能取消新任务", async () => {
		await store("正文", [message("user", "前".repeat(500_000) + "结束关键词")]);
		await host.catalog.refresh();
		const other = host.createClient();
		const first = await client.query({ query: "searchSessions", cwd, text: "不存在" });
		const cancelled = client.query({ query: "continueSessionSearch", id: first.id });
		const cancelledResult = expect(cancelled).rejects.toThrow();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const second = await client.query({ query: "searchSessions", cwd, text: "结束关键词" });
		await cancelledResult;
		await expect(client.query({ query: "continueSessionSearch", id: first.id })).rejects.toThrow("搜索任务已结束");
		await expect(other.query({ query: "continueSessionSearch", id: second.id })).rejects.toThrow("搜索任务已结束");
		await client.dispatch({ action: "cancelSessionSearch", id: first.id });
		await other.dispatch({ action: "cancelSessionSearch", id: second.id });
		const third = await other.query({ query: "searchSessions", cwd, text: "结束关键词" });
		const results = await Promise.all([
			client.query({ query: "continueSessionSearch", id: second.id }),
			other.query({ query: "continueSessionSearch", id: third.id }),
		]);
		expect(results.map((page) => page.hits.length)).toEqual([1, 1]);
	});

	it("首批返回前连续启动搜索，只保留最后一个任务", async () => {
		await store("正文", [message("user", "目标")]);
		await host.catalog.refresh();
		const first = client.query({ query: "searchSessions", cwd, text: "旧查询" });
		const rejected = expect(first).rejects.toThrow();
		const second = await client.query({ query: "searchSessions", cwd, text: "目标" });
		await rejected;
		expect((await client.query({ query: "continueSessionSearch", id: second.id })).hits).toHaveLength(1);
	});

	it("空目录和恰好满批的标题结果直接完成，不要求拉取空尾页", async () => {
		await host.catalog.refresh();
		expect(await client.query({ query: "searchSessions", cwd, text: "标题" })).toMatchObject({ hits: [], scanned: 0, total: 0, done: true });
		for (let index = 0; index < 32; index++) await store(`标题 ${index}`, []);
		await host.catalog.refresh();
		const page = await client.query({ query: "searchSessions", cwd, text: "标题" });
		expect(page.hits).toHaveLength(32);
		expect(page).toMatchObject({ scanned: 32, total: 32, done: true });
	});
});
