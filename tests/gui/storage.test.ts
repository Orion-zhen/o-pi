import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import type { StorageEntry } from "../../src/gui/storage.ts";
import { JsonlTelemetryWriter } from "../../src/harness/telemetry/writer.ts";
import { telemetryRunsDirectory, userHistoryPath } from "../../src/harness/storage/paths.ts";
import { UserHistoryStore } from "../../src/harness/user-history.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";
import { storeSession } from "./session-fixture.ts";

vi.mock("node:fs/promises", { spy: true });

const temp = useTempDir("opi-storage-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP");
let client: GuiClient;

beforeEach(async () => {
	setTestHome(temp.path);
	process.env.PI_CODING_AGENT_DIR = path.join(temp.path, ".pi", "agent");
	const temporary = path.join(temp.path, "tmp");
	await mkdir(temporary);
	process.env.TMPDIR = process.env.TMP = process.env.TEMP = temporary;
	client = new GuiHost().createClient();
});
afterEach(async () => { await client.host.dispose(); });

async function entries(): Promise<StorageEntry[]> {
	return (await client.query({ query: "storage" })).groups.flatMap((group) => group.entries);
}
function entryAt(entries: StorageEntry[], file: string): StorageEntry {
	const entry = entries.find((entry) => entry.path === file);
	if (!entry) throw new Error(`未扫描到存储条目：${file}`);
	return entry;
}

describe("GUI 存储清理", () => {
	it("输入历史在扫描后被追加时拒绝删除，刷新清理后仍可继续记录", async () => {
		const initial = await client.query({ query: "storage" });
		expect(initial.groups.find((group) => group.id === "sessions")).toMatchObject({ entries: [], error: null });
		const history = new UserHistoryStore();
		await history.append({ cwd: temp.path, session: "first", text: "首次输入" });
		const selected = entryAt(await entries(), userHistoryPath());
		await history.append({ cwd: temp.path, session: "second", text: "其他窗口的输入" });
		await expect(client.dispatch({ action: "removeStorage", ids: [selected.id] })).rejects.toThrow("条目已变化");
		expect((await history.load(temp.path)).map((record) => record.text)).toEqual(["首次输入", "其他窗口的输入"]);
		const refreshed = entryAt(await entries(), userHistoryPath());
		await client.dispatch({ action: "removeStorage", ids: [refreshed.id] });
		expect(await history.load(temp.path)).toEqual([]);
		await history.append({ cwd: temp.path, session: "second", text: "清理后的输入" });
		expect((await history.load(temp.path)).map((record) => record.text)).toEqual(["清理后的输入"]);
	});

	it("正在写入的遥测不可删除，关闭写入后刷新即可清理", async () => {
		const errors: unknown[] = [];
		const writer = await JsonlTelemetryWriter.open("storage-test", (error) => errors.push(error));
		const file = path.join(telemetryRunsDirectory(), "storage-test.jsonl");
		try {
			writer.append({ type: "run", run_id: "storage-test", session_id: "session", at: new Date().toISOString(), reason: "startup", cwd: temp.path });
			await expect.poll(async () => (await stat(file)).size).toBeGreaterThan(0);
			const active = entryAt(await entries(), file);
			expect(active.blocked).toBe("正在使用");
			await expect(client.dispatch({ action: "removeStorage", ids: [active.id] })).rejects.toThrow("正在使用");
		} finally { await writer.close(); }
		expect(errors).toEqual([]);
		const closed = entryAt(await entries(), file);
		expect(closed.blocked).toBeNull();
		await client.dispatch({ action: "removeStorage", ids: [closed.id] });
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("会话批量删除部分失败时保留原始错误，刷新后可清理剩余会话", async () => {
		const options = { cwd: path.join(temp.path, "project"), agentDir: path.join(temp.path, ".pi", "agent"), provider: "fixture" };
		const first = await storeSession({ ...options, name: "第一个会话" });
		const second = await storeSession({ ...options, name: "第二个会话" });
		const scanned = await entries();
		const ids = [first, second].map((file) => entryAt(scanned, file).id);
		const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const failure = Object.assign(new Error("文件被其他程序占用"), { code: "EBUSY" });
		vi.mocked(unlink).mockImplementation(async (file) => {
			if (file === second) throw failure;
			return fs.unlink(file);
		});
		try {
			await expect(client.dispatch({ action: "removeStorage", ids })).rejects.toMatchObject({ code: "EBUSY", message: failure.message });
			await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(second, "utf8")).toContain("第二个会话");
		} finally { vi.mocked(unlink).mockImplementation(fs.unlink); }
		const refreshed = await entries();
		expect(refreshed.some((entry) => entry.path === first)).toBe(false);
		await client.dispatch({ action: "removeStorage", ids: [entryAt(refreshed, second).id] });
		await expect(readFile(second)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
