import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionIndex, readSessionPaths } from "../../../../src/gui/host/catalog/session-index.ts";
import { GuiSessionCatalog } from "../../../../src/gui/host/catalog/sessions.ts";
import { preserveEnv, useTempDir } from "../../../helpers/lifecycle.ts";
import { storeSession } from "../../helpers/session-fixture.ts";

const temp = useTempDir("opi-session-index-");
preserveEnv("PI_CODING_AGENT_DIR");
let agentDir: string;
let cwd: string;
const errors = vi.fn();
const createCatalog = (options: Partial<ConstructorParameters<typeof GuiSessionCatalog>[0]> = {}) => new GuiSessionCatalog({
	publish: () => {}, protectedWorkspaces: () => [cwd], scope: () => [cwd], reportError: errors, ...options,
});
beforeEach(() => {
	errors.mockClear();
	agentDir = path.join(temp.path, "agent");
	cwd = path.join(temp.path, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); expect(errors).not.toHaveBeenCalled(); });
const store = (name: string, timestamp = Date.now()) => storeSession({ cwd, agentDir, provider: "test", name, timestamp });

describe("会话列表按范围直读磁盘", () => {
	it("与 SDK 的标题和活动时间一致，不缓存对话正文", async () => {
		const file = await store("初始标题", 1000);
		SessionManager.open(file).appendSessionInfo("");
		await storeSession({ cwd: path.join(temp.path, "other"), agentDir, provider: "test", text: "多行\n问题 " + "文".repeat(200), timestamp: 2000 });
		const expected = (await SessionManager.listAll()).map(({ path, cwd, name, firstMessage, modified }) => ({
			path, cwd, title: name || firstMessage.replace(/\s+/g, " ").slice(0, 160), modified: modified.toISOString(),
		}));
		expect((await readSessionIndex()).sessions).toEqual(expected);
	});

	it("工作区按会话文件最大 mtime 排序，受保护工作区保持置顶", async () => {
		const older = path.join(temp.path, "a-older");
		const newer = path.join(temp.path, "z-newer");
		const current = await store("启动工作区", 1000);
		const latest = await storeSession({ cwd: newer, agentDir, provider: "test", timestamp: 1000 });
		const previous = await storeSession({ cwd: newer, agentDir, provider: "test", timestamp: 500 });
		const file = await storeSession({ cwd: older, agentDir, provider: "test", timestamp: 2000 });
		await Promise.all([utimes(current, 1, 1), utimes(latest, 3, 3), utimes(previous, 0.5, 0.5), utimes(file, 2, 2)]);
		const catalog = createCatalog();
		try {
			await catalog.refresh();
			expect(catalog.workspaces?.map(({ path }) => path)).toEqual([cwd, newer, older]);
			SessionManager.open(file).appendSessionInfo("更新标题");
			await utimes(file, 4, 4);
			await catalog.refresh();
			expect(catalog.workspaces?.map(({ path }) => path)).toEqual([cwd, older, newer]);
		} finally { await catalog.dispose(); }
	});

	it("当前工作区读取摘要，其他工作区和路径枚举只读文件头，扩大范围后重新读取", async () => {
		const current = await store("当前工作区");
		const otherCwd = path.join(temp.path, "other");
		const other = await storeSession({ cwd: otherCwd, agentDir, provider: "test", name: "其他工作区", text: "x".repeat(1024 * 1024) });
		const streams: fs.ReadStream[] = [];
		const original = fs.createReadStream;
		vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
			const stream = original(...args); streams.push(stream); return stream;
		});
		syncBuiltinESMExports();
		let scope: string[] | undefined = [cwd];
		const catalog = createCatalog({ scope: () => scope });
		try {
			await catalog.refresh();
			expect(catalog.value).toEqual([expect.objectContaining({ path: current })]);
			expect(catalog.workspaces?.map((workspace) => workspace.path)).toContain(otherCwd);
			expect(streams.find((stream) => stream.path === other)?.bytesRead).toBeLessThan(1024 * 1024);
			streams.length = 0;
			expect(await readSessionPaths(otherCwd)).toEqual(new Set([other]));
			expect(streams.find((stream) => stream.path === other)?.bytesRead).toBeLessThan(1024 * 1024);
			streams.length = 0;
			scope = undefined;
			await catalog.refresh();
			expect(catalog.value).toHaveLength(2);
			expect(streams.find((stream) => stream.path === other)?.bytesRead).toBeGreaterThan(1024 * 1024);
			streams.length = 0;
			scope = [cwd];
			await catalog.refresh();
			expect(catalog.value).toHaveLength(1);
			expect(streams.find((stream) => stream.path === other)?.bytesRead).toBeLessThan(1024 * 1024);
		} finally { await catalog.dispose(); }
	});

	it("自动刷新合并为一次读取，显式刷新立即执行且清除延迟任务", async () => {
		await store("历史标题");
		const publish = vi.fn();
		const catalog = createCatalog({ publish });
		const read = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		vi.useFakeTimers();
		try {
			catalog.schedule(); catalog.schedule();
			await vi.advanceTimersByTimeAsync(99);
			expect(read).not.toHaveBeenCalled();
			await catalog.refresh();
			await vi.advanceTimersByTimeAsync(100);
			expect(read).toHaveBeenCalledTimes(1);
			expect(publish.mock.calls.at(-1)?.[2]).toBeNull();
			catalog.schedule();
			await vi.advanceTimersByTimeAsync(100);
			vi.useRealTimers();
			await expect.poll(() => publish.mock.calls.length).toBe(2);
			expect(publish.mock.calls.at(-1)?.[2]).toEqual([]);
		} finally { vi.useRealTimers(); await catalog.dispose(); }
	});

	it("读取期间再次收到目录变更会继续读取，不丢失较晚写入的内容", async () => {
		const file = await store("初始标题");
		const publish = vi.fn();
		const catalog = createCatalog({ publish });
		const original = fs.createReadStream;
		let changed = false;
		vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
			const stream = original(...args);
			if (!changed) {
				changed = true;
				stream.once("close", () => {
					fs.appendFileSync(file, JSON.stringify({ type: "session_info", name: "读取期间改名" }) + "\n");
					catalog.schedule(path.dirname(file));
				});
			}
			return stream;
		});
		syncBuiltinESMExports();
		try {
			await catalog.refresh();
			expect(catalog.value).toEqual([expect.objectContaining({ title: "读取期间改名" })]);
			expect(publish.mock.calls.at(-1)?.[2]).toEqual([cwd]);
		} finally { await catalog.dispose(); }
	});

	it("工作区删除或恢复后，刷新更新存在状态", async () => {
		await store("工作区历史");
		const catalog = createCatalog();
		try {
			await catalog.refresh();
			expect(catalog.workspaces).toEqual([expect.objectContaining({ path: cwd, exists: true })]);
			await rm(cwd, { recursive: true });
			await catalog.refresh();
			expect(catalog.workspaces).toEqual([expect.objectContaining({ path: cwd, exists: false })]);
			await mkdir(cwd);
			await catalog.refresh();
			expect(catalog.workspaces).toEqual([expect.objectContaining({ path: cwd, exists: true })]);
		} finally { await catalog.dispose(); }
	});
});
