import { appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuiSessionCatalog } from "../../../../src/gui/host/catalog/sessions.ts";
import { preserveEnv, useTempDir } from "../../../helpers/lifecycle.ts";
import { storeSession } from "../../helpers/session-fixture.ts";

const temp = useTempDir("opi-session-watch-");
preserveEnv("PI_CODING_AGENT_DIR");
let cwd: string;
let agentDir: string;
let catalog: GuiSessionCatalog;
const publish = vi.fn<ConstructorParameters<typeof GuiSessionCatalog>[0]["publish"]>();
const errors = vi.fn<(error: unknown) => void>();
beforeEach(async () => {
	cwd = path.join(temp.path, "project");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	publish.mockClear(); errors.mockClear();
	catalog = new GuiSessionCatalog({ publish, protectedWorkspaces: () => [cwd], scope: () => [cwd], reportError: errors });
	catalog.watch();
	await catalog.refresh();
});
afterEach(async () => { await catalog.dispose(); expect(errors).not.toHaveBeenCalled(); });
const store = (name: string) => storeSession({ cwd, agentDir, provider: "test", name });
const title = () => catalog.value?.[0]?.title;

describe("磁盘变更自动推送历史目录", () => {
	it("首次创建、追加、原子替换、截断和删除不依赖手动刷新", async () => {
		const file = await store("初始标题");
		await expect.poll(title).toBe("初始标题");
		const before = publish.mock.calls.length;
		await appendFile(file, '{"type":"session_info","name":"追加');
		await expect.poll(() => publish.mock.calls.length).toBeGreaterThan(before);
		expect(title()).toBe("初始标题");
		await appendFile(file, '标题"}\n');
		await expect.poll(title).toBe("追加标题");
		const content = await readFile(file, "utf8");
		await writeFile(`${file}.tmp`, content.replace("追加标题", "替换标题"));
		await rename(`${file}.tmp`, file);
		await expect.poll(title).toBe("替换标题");
		await writeFile(file, content.split("\n")[0] + "\n");
		await expect.poll(title).toBe("(no messages)");
		await rm(file);
		await expect.poll(() => catalog.value).toEqual([]);
	});

	it("会话根目录删除和重建后继续监听", async () => {
		await store("删除前");
		await expect.poll(title).toBe("删除前");
		await rm(path.join(agentDir, "sessions"), { recursive: true });
		await expect.poll(() => catalog.value).toEqual([]);
		const file = await store("重建后");
		await expect.poll(title).toBe("重建后");
		await appendFile(file, '{"type":"session_info","name":"重建后追加"}\n');
		await expect.poll(title).toBe("重建后追加");
	});

	it("工作区目录替换后监听新目录，不继续依赖旧监听句柄", async () => {
		const file = await store("目录替换前");
		await expect.poll(title).toBe("目录替换前");
		const directory = path.dirname(file);
		const content = await readFile(file, "utf8");
		await rename(directory, path.join(temp.path, "old-sessions"));
		await mkdir(directory);
		await writeFile(file, content.replace("目录替换前", "目录替换后"));
		await expect.poll(title).toBe("目录替换后");
		await appendFile(file, '{"type":"session_info","name":"新目录追加"}\n');
		await expect.poll(title).toBe("新目录追加");
	});

	it("其他工作区自动出现，只读文件头且不扩大摘要范围", async () => {
		const other = path.join(temp.path, "other");
		await storeSession({ cwd: other, agentDir, provider: "test", name: "其他工作区" });
		await expect.poll(() => catalog.workspaces?.map((workspace) => workspace.path)).toContain(other);
		expect(catalog.value).toEqual([]);
		await rm(path.join(agentDir, "sessions", "other"), { recursive: true });
		await expect.poll(() => catalog.workspaces?.map((workspace) => workspace.path)).not.toContain(other);
	});

	it("正文变化只使对应工作区失效，删除最后一条历史仍通知旧工作区", async () => {
		const other = path.join(temp.path, "other");
		const currentFile = await store("当前历史");
		const otherFile = await storeSession({ cwd: other, agentDir, provider: "test", name: "其他历史" });
		await expect.poll(() => catalog.workspaces?.map((workspace) => workspace.path)).toContain(other);
		await catalog.refresh();
		publish.mockClear();
		await appendFile(otherFile, '{"type":"message","message":{"role":"user","content":"其他正文"}}\n');
		await expect.poll(() => publish.mock.calls.some(([, , invalidated]) => invalidated?.includes(other))).toBe(true);
		expect(publish.mock.calls.every(([, , invalidated]) => invalidated !== null && !invalidated.includes(cwd))).toBe(true);
		publish.mockClear();
		await appendFile(currentFile, '{"type":"message","message":{"role":"user","content":"当前正文"}}\n');
		await expect.poll(() => publish.mock.calls.some(([, , invalidated]) => invalidated?.includes(cwd))).toBe(true);
		expect(title()).toBe("当前历史");
		publish.mockClear();
		await rm(currentFile);
		await expect.poll(() => catalog.value).toEqual([]);
		expect(publish.mock.calls.some(([, , invalidated]) => invalidated?.includes(cwd))).toBe(true);
	});

	it("链接工作区的外部文件变化也触发读取，关闭后停止发布", async () => {
		const external = path.join(temp.path, "external");
		const file = await storeSession({ cwd, agentDir: external, provider: "test", name: "链接会话" });
		await mkdir(path.join(agentDir, "sessions"), { recursive: true });
		await symlink(path.dirname(file), path.join(agentDir, "sessions", "linked"), "dir");
		await expect.poll(title).toBe("链接会话");
		await appendFile(file, '{"type":"session_info","name":"链接文件追加"}\n');
		await expect.poll(title).toBe("链接文件追加");
		await catalog.dispose();
		publish.mockClear();
		await appendFile(file, '{"type":"session_info","name":"关闭后不发布"}\n');
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(publish).not.toHaveBeenCalled();
	});
});
