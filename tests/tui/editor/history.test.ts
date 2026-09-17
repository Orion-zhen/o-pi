import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userCachePath } from "../../../src/harness/cache-path.ts";
import { buildInitialHistory, UserHistoryStore, type UserHistoryRecord } from "../../../src/harness/user-history.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-user-history-");
preserveEnv("HOME", "USERPROFILE");
beforeEach(() => setTestHome(temp.path));
afterEach(() => vi.useRealTimers());

const historyPath = () => userCachePath("user-history", "history.jsonl");

describe("路径级用户历史", () => {
	it("以 JSONL 单文件追加，并只加载当前路径的最近记录", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const store = new UserHistoryStore();
		const projectA = path.join(temp.path, "a");
		const projectB = path.join(temp.path, "b");
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		await store.append({ cwd: projectA, session: "s1", text: " first " });
		vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
		await store.append({ cwd: projectB, session: "s2", text: "other" });
		vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
		await store.append({ cwd: projectA, session: "s3", text: "multi\nline" });
		const records = await store.load(projectA);
		const lines = (await readFile(historyPath(), "utf8")).trimEnd().split("\n");
		expect(records.map((record) => record.text)).toEqual(["first", "multi\nline"]);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain('"timestamp":"2026-01-01T00:00:00.000Z"');
		expect(lines[2]).toContain('"text":"multi\\nline"');
	});

	it("多个存储实例并发写同一个真实缓存文件，不互相覆盖", async () => {
		const first = new UserHistoryStore();
		const second = new UserHistoryStore();
		const cwd = path.join(temp.path, "project");
		await Promise.all(Array.from({ length: 20 }, (_, index) => {
			const store = index % 2 === 0 ? first : second;
			return store.append({ cwd, session: `s${index % 2}`, text: `command-${index}` });
		}));
		const records = await first.load(cwd);
		expect(records).toHaveLength(20);
		expect(new Set(records.map((record) => record.text)).size).toBe(20);
	});

	it("实际超过 8 MiB 后压缩，每个路径最多保留 100 条", async () => {
		const store = new UserHistoryStore();
		const smallCwd = path.join(temp.path, "small");
		const largeCwd = path.join(temp.path, "large");
		for (let index = 0; index < 130; index += 1) {
			await store.append({ cwd: smallCwd, session: "session", text: `small-${index}` });
		}
		expect((await store.load(smallCwd)).map((record) => record.text)).toEqual(
			Array.from({ length: 100 }, (_, index) => `small-${index + 30}`),
		);
		const body = "x".repeat(128 * 1024);
		for (let index = 0; index < 72; index += 1) {
			await store.append({ cwd: largeCwd, session: "session", text: `${index}-${body}` });
		}
		const content = await readFile(historyPath(), "utf8");
		const persisted = content.trimEnd().split("\n").map((line) => JSON.parse(line) as UserHistoryRecord);
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(persisted.filter((record) => record.cwd === smallCwd)).toHaveLength(100);
		expect((await store.load(largeCwd)).at(-1)?.text).toBe(`71-${body}`);
	});

	it("跨 64 KiB 读取块还原完整 Unicode 记录", async () => {
		const store = new UserHistoryStore();
		const cwd = path.join(temp.path, "project");
		const text = `prefix-${"界".repeat(25_000)}-suffix`;
		await store.append({ cwd, session: "session", text });
		expect((await store.load(cwd)).map((record) => record.text)).toEqual([text]);
	});

	it("跳过不能放入 6 MiB 压缩目标的单条输入", async () => {
		const store = new UserHistoryStore();
		const cwd = path.join(temp.path, "project");
		await store.append({ cwd, session: "session", text: "kept" });
		await store.append({ cwd, session: "session", text: "x".repeat(6 * 1024 * 1024) });
		expect((await store.load(cwd)).map((record) => record.text)).toEqual(["kept"]);
		expect(Buffer.byteLength(await readFile(historyPath(), "utf8"))).toBeLessThan(6 * 1024 * 1024);
	});

	it("跳过旧文件中的超长记录，并在下次写入时清理", async () => {
		const cwd = path.join(temp.path, "project");
		const older = JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", cwd, session: "session", text: "older" });
		const oversized = JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", cwd, session: "session", text: "x".repeat(9 * 1024 * 1024) });
		await mkdir(path.dirname(historyPath()), { recursive: true });
		await writeFile(historyPath(), `${older}\n${oversized}\n`);
		const store = new UserHistoryStore();
		expect((await store.load(cwd)).map((record) => record.text)).toEqual(["older"]);
		await store.append({ cwd, session: "session", text: "recent" });
		expect(Buffer.byteLength(await readFile(historyPath(), "utf8"))).toBeLessThanOrEqual(6 * 1024 * 1024);
		expect((await store.load(cwd)).map((record) => record.text)).toEqual(["older", "recent"]);
	});

	it("仅用当前会话消息补齐该会话开始持久化前的部分", () => {
		const records = [
			{ timestamp: "2026-01-01T00:00:02.000Z", cwd: "/project", session: "current", text: "recorded" },
			{ timestamp: "2026-01-01T00:00:03.000Z", cwd: "/project", session: "other", text: "other session" },
		];
		const messages = [
			{ timestamp: Date.parse("2026-01-01T00:00:01.000Z"), text: "before feature" },
			{ timestamp: Date.parse("2026-01-01T00:00:02.500Z"), text: "already covered" },
		];
		expect(buildInitialHistory(records, messages, "current")).toEqual(["before feature", "recorded", "other session"]);
	});
});
