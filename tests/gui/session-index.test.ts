import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuiSessionIndex } from "../../src/gui/host/session-index.ts";
import { GuiSessionCatalog } from "../../src/gui/host/sessions.ts";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.ts";
import { storeSession } from "./session-fixture.ts";

const temp = useTempDir("opi-session-index-");
preserveEnv("PI_CODING_AGENT_DIR");
let agentDir: string;
let cwd: string;
beforeEach(() => {
	agentDir = path.join(temp.path, "agent");
	cwd = path.join(temp.path, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
const store = (name: string, timestamp = Date.now()) => storeSession({ cwd, agentDir, provider: "test", name, timestamp });

describe("会话列表增量读取", () => {
	it("与 SDK 的标题和活动时间一致，不缓存对话正文", async () => {
		const file = await store("初始标题", 1000);
		SessionManager.open(file).appendSessionInfo("");
		await storeSession({ cwd: path.join(temp.path, "other"), agentDir, provider: "test", text: "多行\n问题 " + "文".repeat(200), timestamp: 2000 });
		const expected = (await SessionManager.listAll()).map(({ path, cwd, name, firstMessage, modified }) => ({
			path, cwd, title: name || firstMessage.replace(/\s+/g, " ").slice(0, 160), modified: modified.toISOString(),
		}));
		expect(await new GuiSessionIndex().list()).toEqual(expected);
	});

	it("重复刷新不读取历史正文，改名只重读变化的文件", async () => {
		const first = await store("第一个", 1000);
		const second = await store("第二个", 2000);
		const index = new GuiSessionIndex();
		const read = vi.spyOn(fs, "createReadStream");
		syncBuiltinESMExports();
		const initial = await index.list();
		expect(read).toHaveBeenCalledTimes(2);
		read.mockClear();
		expect(await index.list()).toEqual(initial);
		expect(read).not.toHaveBeenCalled();
		SessionManager.open(first).appendSessionInfo("重命名");
		const changed = await index.list();
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[0]).toBe(first);
		expect(changed.find((item) => item.path === first)?.title).toBe("重命名");
		expect(changed.find((item) => item.path === second)).toBe(initial.find((item) => item.path === second));
	});

	it("外部新增、删除、替换及未写完的尾行在刷新后可见", async () => {
		const index = new GuiSessionIndex();
		expect(await index.list()).toEqual([]);
		const file = await store("旧标题");
		expect(await index.list()).toHaveLength(1);
		await appendFile(file, '{"type":"session_info","name":"追加');
		expect((await index.list())[0]?.title).toBe("旧标题");
		await appendFile(file, '标题"}\n');
		expect((await index.list())[0]?.title).toBe("追加标题");
		const replacement = `${file}.tmp`;
		await writeFile(replacement, (await readFile(file, "utf8")).replace("追加标题", "替换标题"));
		await rename(replacement, file);
		expect((await index.list())[0]?.title).toBe("替换标题");
		await rm(file);
		expect(await index.list()).toEqual([]);
		await store("新历史");
		expect((await index.list())[0]?.title).toBe("新历史");
	});

	it("会话列表刷新仍更新工作区存在状态，关闭后不发布", async () => {
		await store("工作区历史");
		const publish = vi.fn();
		const catalog = new GuiSessionCatalog(publish, () => [cwd]);
		await catalog.refresh();
		expect(catalog.workspaces).toEqual([{ path: cwd, exists: true }]);
		await catalog.refresh();
		expect(publish).toHaveBeenCalledTimes(1);
		await rm(cwd, { recursive: true });
		await catalog.refresh();
		expect(catalog.workspaces).toEqual([{ path: cwd, exists: false }]);
		await mkdir(cwd);
		await catalog.refresh();
		expect(catalog.workspaces).toEqual([{ path: cwd, exists: true }]);
		await catalog.dispose();
		publish.mockClear();
		await catalog.refresh();
		expect(publish).not.toHaveBeenCalled();
	});
});
