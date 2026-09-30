import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuiHistory } from "../../src/gui/host/history.ts";
import { GuiPayloads } from "../../src/gui/host/payloads.ts";
import { sessionTree } from "../../src/gui/messages.ts";
import { locateTranscript } from "../../src/gui/ui/transcript-location.ts";
import { assistant } from "./transcript-fixtures.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-history-projection-");

const user = (content: string) => ({ role: "user" as const, content, timestamp: 100 });

describe("统一历史身份", () => {
	it("连续快照复用未变化的历史，不重复遍历 SDK 条目或上下文", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("历史消息"));
		const history = new GuiHistory(new GuiPayloads());
		const before = history.project(manager);
		const entries = vi.spyOn(manager, "getEntries");
		const context = vi.spyOn(manager, "buildContextEntries");
		for (let index = 0; index < 20; index++) expect(history.project(manager)).toBe(before);
		expect(entries).not.toHaveBeenCalled();
		expect(context).not.toHaveBeenCalled();
	});
	it("只切换分支、重置叶节点或重建同 ID 会话也会更新投影", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage(user("第一条"));
		manager.appendMessage(user("第二条"));
		const history = new GuiHistory(new GuiPayloads());
		const before = history.project(manager);
		manager.branch(first);
		const branch = history.project(manager);
		expect(branch.entries).toBe(before.entries);
		expect(branch.contextEntryIds).toEqual([first]);
		manager.resetLeaf();
		expect(history.project(manager).contextEntryIds).toEqual([]);
		manager.newSession({ id: manager.getSessionId() });
		manager.appendMessage(user("新会话消息"));
		manager.appendMessage(user("新会话回复"));
		manager.resetLeaf();
		expect(history.project(manager).entries.flatMap((entry) => entry.messages)).toEqual([user("新会话消息"), user("新会话回复")]);
	});
	it("重读同一文件后即使条目数和叶节点相同，也不复用旧正文", async () => {
		const manager = SessionManager.create(temp.path, temp.path);
		manager.appendMessage(user("旧正文"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("缺少会话文件");
		const history = new GuiHistory(new GuiPayloads());
		const before = history.project(manager);
		await writeFile(file, (await readFile(file, "utf8")).replace("旧正文", "新正文"));
		manager.setSessionFile(file);
		const after = history.project(manager);
		expect(after.contextEntryIds).toEqual(before.contextEntryIds);
		expect(after.entries.flatMap((entry) => entry.messages)).toEqual([user("新正文")]);
		expect(before.entries.flatMap((entry) => entry.messages)).toEqual([user("旧正文")]);
	});
	it("压缩重排与相同时间戳不影响定位，正文只传一份", () => {
		const manager = SessionManager.inMemory();
		const old = manager.appendMessage(user("已压缩的问题"));
		const kept = manager.appendMessage(user("保留的问题"));
		const answer = manager.appendMessage(assistant([{ type: "text", text: "唯一完整回复" }], "stop"));
		const summary = manager.appendCompaction("上下文摘要", kept, 1000);
		const history = new GuiHistory(new GuiPayloads()).project(manager);
		const snapshot = { ...history, leafId: manager.getLeafId() };
		const current = locateTranscript(snapshot, kept);
		expect(current.entryIds).toEqual([summary, kept, answer]);
		expect(current.preview).toBe(false);
		expect(locateTranscript(snapshot, old)).toMatchObject({ preview: true, entryIds: [old], messages: [user("已压缩的问题")] });
		expect(JSON.stringify(history).split("唯一完整回复")).toHaveLength(2);
		expect(sessionTree(history.entries, snapshot.leafId)[0]?.entry.id).toBe(old);
	});
	it("带系统状态的压缩条目为每条消息保留相同的来源 ID，消息树只展示摘要", () => {
		const timestamp = "2026-09-28T00:00:00.000Z";
		const manager = SessionManager.inMemory("/workspace", undefined, [
			{ type: "session", version: 3, id: "fixture", cwd: "/workspace", timestamp },
			{ type: "compaction", id: "summary", parentId: null, timestamp, summary: "历史摘要", firstKeptEntryId: "", tokensBefore: 100,
				systemMessage: { role: "system", content: "系统提示", timestamp: 100 } },
		]);
		const history = new GuiHistory(new GuiPayloads()).project(manager);
		const current = locateTranscript({ ...history, leafId: "summary" }, "summary");
		expect(current.entryIds).toEqual(["summary", "summary"]);
		expect(current.messages.map((message) => message.role)).toEqual(["system", "compactionSummary"]);
		expect(current.preview).toBe(false);
		expect(sessionTree(history.entries, "summary")).toHaveLength(1);
	});
	it("追加消息和标签不会重新转换未变化的正文", () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage(user("最初的问题"));
		const history = new GuiHistory(new GuiPayloads());
		const before = history.project(manager);
		manager.appendMessage(assistant([{ type: "text", text: "回复" }], "stop"));
		const after = history.project(manager);
		expect(after.entries[0]).toBe(before.entries[0]);
		manager.appendLabelChange(first, "书签");
		const labeled = history.project(manager);
		expect(labeled.entries[0]?.label).toBe("书签");
		expect(labeled.entries[0]?.messages).toBe(before.entries[0]?.messages);
		expect(before.entries[0]?.label).toBeUndefined();
	});
});

describe("载荷引用", () => {
	it("判断大工具结果大小时不构造整份 JSON 字符串，完整结果仍可读取", () => {
		const payloads = new GuiPayloads();
		const text = "完整输出\\n".repeat(1_000_000);
		const stringify = JSON.stringify;
		let serialized = 0;
		const encode = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
			const json = stringify(value, replacer, space);
			serialized = Math.max(serialized, json.length);
			return json;
		});
		try {
			const output = payloads.output("extension", { content: [{ type: "text", text }] });
			if (output.kind !== "reference") throw new Error("缺少工具结果引用");
			expect(payloads.toolOutput(output.id).content).toEqual([{ type: "text", text }]);
			expect(serialized).toBeLessThanOrEqual(64_000 * 6);
		} finally { encode.mockRestore(); }
	});
	it("保留原有内联阈值，正确计算转义字符和嵌套详情", () => {
		const payloads = new GuiPayloads();
		const overhead = JSON.stringify({ content: [{ type: "text", text: "" }] }).length;
		for (const value of [
			{ content: [{ type: "text", text: "x".repeat(64_000 - overhead) }] },
			{ content: [{ type: "text", text: "x".repeat(64_001 - overhead) }] },
			{ content: [{ type: "text", text: "\n\"\\".repeat(12_000) }] },
			{ content: [], details: { nested: { diff: "中文差异".repeat(20_000) } } },
			{ content: [], details: { lines: Array.from({ length: 20_000 }, (_, index) => [index, null, true]) } },
		]) {
			const expected = JSON.stringify(value).length <= 64_000 ? "inline" : "reference";
			const output = payloads.output("extension", value);
			expect(output.kind).toBe(expected);
			expect(output.kind === "inline" ? output.value : payloads.toolOutput(output.id)).toEqual(value);
		}
	});
	it("只替换标准图片块，不改写扩展数据和工具参数中的同名字段", () => {
		const payloads = new GuiPayloads();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const message = payloads.message({ role: "user", content: [image], timestamp: 1 });
		if (message.role !== "user" || typeof message.content === "string") throw new Error("缺少用户正文");
		const block = message.content[0];
		if (block?.type !== "image") throw new Error("缺少图片引用");
		expect(payloads.image(block.imageId)).toBe(image.data);
		const details = { data: "原始业务字段", mimeType: "image/png", nested: image };
		const output = payloads.output("extension", { content: [{ type: "text", text: "扩展结果" }], details });
		expect(output).toMatchObject({ kind: "inline", value: { details } });
		const call = assistant([{ type: "toolCall", id: "call", name: "extension", arguments: details }]);
		expect(payloads.message(call)).toEqual(call);
	});
	it("大工具结果通过显式引用读取，展开后仍能加载其中的图片", () => {
		const payloads = new GuiPayloads();
		const text = "完整结果".repeat(20_000);
		const output = payloads.output("extension", { content: [{ type: "text", text }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] });
		if (output.kind !== "reference") throw new Error("缺少工具结果引用");
		expect(JSON.stringify(output).length).toBeLessThan(1000);
		const full = payloads.toolOutput(output.id);
		expect(full.content).toEqual([{ type: "text", text }, { type: "image", mimeType: "image/png", imageId: expect.any(String) }]);
	});
});
