import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ProcessTerminal, TuiMainScreen, type EditorTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { UserHistoryEditor } from "../../src/tui/user-history-editor.js";
import {
	buildInitialHistory,
	UserHistoryStore,
} from "../../src/tui/user-history.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-user-history-");

describe("路径级用户历史", () => {
	it("以 JSONL 单文件追加，并只加载当前路径的最近记录", async () => {
		const filePath = path.join(temp.path, "user-history", "history.jsonl");
		const store = new UserHistoryStore({ filePath });
		const projectA = path.join(temp.path, "a");
		const projectB = path.join(temp.path, "b");
		await store.append({ cwd: projectA, session: "s1", text: " first ", timestamp: new Date("2026-01-01T00:00:00Z") });
		await store.append({ cwd: projectB, session: "s2", text: "other", timestamp: new Date("2026-01-01T00:00:01Z") });
		await store.append({ cwd: projectA, session: "s3", text: "multi\nline", timestamp: new Date("2026-01-01T00:00:02Z") });

		const records = await store.load(projectA);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");

		expect(records.map((record) => record.text)).toEqual(["first", "multi\nline"]);
		expect(lines).toHaveLength(3);
		expect(lines.every((line) => JSON.parse(line) !== undefined)).toBe(true);
		expect(lines[0]).toContain('"timestamp":"2026-01-01T00:00:00.000Z"');
		expect(lines[2]).toContain('"text":"multi\\nline"');
	});

	it("多进程式并发写入不会互相覆盖", async () => {
		const filePath = path.join(temp.path, "history.jsonl");
		const first = new UserHistoryStore({ filePath });
		const second = new UserHistoryStore({ filePath });
		const cwd = path.join(temp.path, "project");
		await Promise.all(Array.from({ length: 20 }, (_, index) => {
			const store = index % 2 === 0 ? first : second;
			return store.append({ cwd, session: `s${index % 2}`, text: `command-${index}` });
		}));

		const records = await first.load(cwd);
		expect(records).toHaveLength(20);
		expect(new Set(records.map((record) => record.text)).size).toBe(20);
	});

	it("文件超限后只保留有界、可解析的最近记录", async () => {
		const filePath = path.join(temp.path, "history.jsonl");
		const store = new UserHistoryStore({
			filePath,
			maxFileBytes: 500,
			compactTargetBytes: 400,
			maxEntriesPerPath: 2,
		});
		const cwd = path.join(temp.path, "project");
		for (let index = 0; index < 8; index += 1) {
			await store.append({ cwd, session: "session", text: `${index}-${"x".repeat(100)}` });
		}

		const records = await store.load(cwd);
		const content = await readFile(filePath, "utf8");
		expect(records.length).toBeLessThanOrEqual(2);
		expect(records.at(-1)?.text).toBe(`7-${"x".repeat(100)}`);
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(400);
		expect(content.trimEnd().split("\n").every((line) => JSON.parse(line) !== undefined)).toBe(true);
	});

	it("跨读取块还原上限内的完整记录", async () => {
		const filePath = path.join(temp.path, "multi-block.jsonl");
		const store = new UserHistoryStore({ filePath, maxFileBytes: 150_000, compactTargetBytes: 100_000 });
		const cwd = path.join(temp.path, "project");
		const text = `prefix-${"界".repeat(25_000)}-suffix`;

		await store.append({ cwd, session: "session", text });

		expect((await store.load(cwd)).map((record) => record.text)).toEqual([text]);
	});

	it("跳过超过压缩目标的单条输入，不让历史文件突破上限", async () => {
		const filePath = path.join(temp.path, "oversized-append.jsonl");
		const store = new UserHistoryStore({ filePath, maxFileBytes: 500, compactTargetBytes: 400 });
		const cwd = path.join(temp.path, "project");
		await store.append({ cwd, session: "session", text: "kept" });
		await store.append({ cwd, session: "session", text: "x".repeat(1_000) });

		const content = await readFile(filePath, "utf8");
		expect((await store.load(cwd)).map((record) => record.text)).toEqual(["kept"]);
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(400);
	});

	it("跳过旧文件中的超长记录，并在下次写入时清理", async () => {
		const filePath = path.join(temp.path, "legacy-oversized.jsonl");
		const cwd = path.join(temp.path, "project");
		const older = JSON.stringify({
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			session: "session",
			text: "older",
		});
		const oversized = JSON.stringify({
			timestamp: "2026-01-01T00:00:01.000Z",
			cwd,
			session: "session",
			text: "x".repeat(200_000),
		});
		await writeFile(filePath, `${older}\n${oversized}\n`);
		const store = new UserHistoryStore({ filePath, maxFileBytes: 500, compactTargetBytes: 400 });

		expect((await store.load(cwd)).map((record) => record.text)).toEqual(["older"]);
		await store.append({ cwd, session: "session", text: "recent" });

		const content = await readFile(filePath, "utf8");
		const records = await store.load(cwd);
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(400);
		expect(records.at(-1)?.text).toBe("recent");
		expect(records.every((record) => record.text.length < 200_000)).toBe(true);
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

		expect(buildInitialHistory(records, messages, "current")).toEqual([
			"before feature",
			"recorded",
			"other session",
		]);
	});

	it("编辑器用上下键跨会话导航，并且每次键盘提交只记录一次", () => {
		const recorded = vi.fn();
		const editor = createEditor(["older", "current"], ["older", "current"], recorded);
		editor.addToHistory("older");
		editor.addToHistory("current");
		editor.setText("");

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("current");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older");
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("current");
		editor.handleInput("\x1b[B");
		expect(editor.getText()).toBe("");

		editor.onSubmit = (text) => editor.addToHistory(text);
		editor.setText(" /settings ");
		editor.handleInput("\r");
		expect(recorded).toHaveBeenCalledOnce();
		expect(recorded).toHaveBeenCalledWith("/settings");
	});

	it("follow-up 快捷键绕过 Enter 时仍记录输入", () => {
		const recorded = vi.fn();
		const editor = createEditor([], [], recorded);
		editor.onAction("app.message.followUp", () => {
			editor.addToHistory(editor.getExpandedText());
			editor.setText("");
		});
		editor.setText("queued follow-up");

		editor.handleInput("\x1b\r");

		expect(recorded).toHaveBeenCalledOnce();
		expect(recorded).toHaveBeenCalledWith("queued follow-up");
	});
});

function createEditor(
	initialHistory: readonly string[],
	replayQueue: readonly string[],
	record: (text: string) => void,
): UserHistoryEditor {
	const tui = new TuiMainScreen(new ProcessTerminal());
	const keybindings = KeybindingsManager.create(temp.path);
	const identity = (text: string): string => text;
	const theme: EditorTheme = {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
	return new UserHistoryEditor(tui, theme, keybindings, initialHistory, replayQueue, record);
}
