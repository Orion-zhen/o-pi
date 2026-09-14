import { describe, expect, it } from "vitest";
import { classifyTool, stableExecutableFromCommand } from "../../../src/harness/discord-presence/activity.js";
import { PresenceActivityTracker } from "../../../src/harness/discord-presence/activity-tracker.js";
import { renderDiscordActivity } from "../../../src/harness/discord-presence/render.js";
import { completedTopLevelStringProperty } from "../../../src/harness/discord-presence/streaming.js";
import { configuredProfile, enabledConfig } from "./fixtures.js";

describe("Discord presence 活动与渲染", () => {
	it.each([
		["read", { path: "/repo/src/main.ts" }, { kind: "reading", file: "main.ts", language: "TypeScript" }],
		["edit", { path: "README.md" }, { kind: "editing", file: "README.md", language: "Markdown" }],
		["write", { path: "main.rs" }, { kind: "writing", file: "main.rs", language: "Rust" }],
		["grep", { query: "secret" }, { kind: "searching" }],
		["websearch", { query: "private query" }, { kind: "browsing" }],
		["bash", { command: "TOKEN=x /usr/bin/git status --secret" }, { kind: "shell", executable: "git" }],
		["custom", { value: "private" }, { kind: "other_tool", tool: "custom" }],
	] as const)("将 %s 分类且只保留展示目标", (tool, args, expected) => {
		expect(classifyTool(tool, args)).toMatchObject(expected);
	});

	it("并行工具按启动顺序恢复，结束工具后回到思考，settled 后空闲", () => {
		const tracker = new PresenceActivityTracker();
		tracker.startTurn();
		tracker.startTool("read-1", "read", { path: "a.ts" });
		tracker.startTool("bash-1", "bash", { command: "npm test" });
		expect(tracker.current()).toMatchObject({ kind: "shell", executable: "npm" });
		tracker.endTool("bash-1");
		expect(tracker.current()).toMatchObject({ kind: "reading", file: "a.ts" });
		tracker.endTool("read-1");
		expect(tracker.current().kind).toBe("thinking");
		tracker.clear();
		expect(tracker.current().kind).toBe("idle");
	});

	it("补充较早工具的元数据不改变启动顺序", () => {
		const tracker = new PresenceActivityTracker();
		const a = { messageKey: "message", contentIndex: 0, call: { id: "a", name: "read", arguments: {} } };
		const b = { messageKey: "message", contentIndex: 1, call: { id: "b", name: "bash", arguments: {} } };
		tracker.stream({ ...a, phase: "start" });
		tracker.stream({ ...b, phase: "start" });
		tracker.stream({ ...a, phase: "delta", delta: '{"path":"a.ts"' });
		expect(tracker.current()).toMatchObject({ kind: "shell" });
		tracker.endTool("b");
		expect(tracker.current()).toMatchObject({ kind: "reading", file: "a.ts" });
	});

	it("只在 path 闭合后提取一次，内容中的 path 和后续执行参数不会覆盖文件名", () => {
		const tracker = new PresenceActivityTracker();
		const stream = { messageKey: "message", contentIndex: 0, call: { id: "write-1", name: "write", arguments: {} } };
		tracker.stream({ ...stream, phase: "start" });
		expect(tracker.stream({ ...stream, phase: "delta", delta: '{"path":"/private/src/ind' })).toBe(false);
		expect(tracker.current()).not.toHaveProperty("file");
		expect(tracker.stream({ ...stream, phase: "delta", delta: 'ex.ts","content":"{\\"path\\":\\"fake.ts\\"}' })).toBe(true);
		expect(tracker.current()).toMatchObject({ file: "index.ts" });
		expect(tracker.stream({ ...stream, phase: "delta", delta: " more content" })).toBe(false);
		tracker.stream({ ...stream, phase: "end", call: { ...stream.call, arguments: { path: "wrong.py" } } });
		tracker.startTool("write-1", "write", { path: "also-wrong.py" });
		expect(tracker.current()).toMatchObject({ file: "index.ts", language: "TypeScript" });
	});

	it("稳定文件没有语言信息时，不混入执行参数中另一个文件的语言", () => {
		const tracker = new PresenceActivityTracker();
		const stream = { messageKey: "message", contentIndex: 0, call: { id: "read", name: "read", arguments: {} } };
		tracker.stream({ ...stream, phase: "start" });
		tracker.stream({ ...stream, phase: "delta", delta: '{"path":"README"' });
		tracker.startTool("read", "read", { path: "wrong.py" });
		expect(tracker.current()).toEqual({ kind: "reading", tool: "read", file: "README" });
	});

	it("等待首个 Shell word 稳定，最终事件补全单词，执行事件不覆盖", () => {
		const tracker = new PresenceActivityTracker();
		const stream = { messageKey: "message", contentIndex: 0, call: { id: "bash-1", name: "bash", arguments: {} } };
		tracker.stream({ ...stream, phase: "start" });
		expect(tracker.stream({ ...stream, phase: "delta", delta: "", call: { ...stream.call, arguments: { command: "NODE_ENV=test np" } } })).toBe(false);
		expect(tracker.stream({ ...stream, phase: "delta", delta: "", call: { ...stream.call, arguments: { command: "NODE_ENV=test npm run test" } } })).toBe(true);
		tracker.startTool("bash-1", "bash", { command: "git status" });
		expect(tracker.current().executable).toBe("npm");
		tracker.endTool("bash-1");
		tracker.stream({ ...stream, phase: "start" });
		tracker.stream({ ...stream, phase: "end", call: { ...stream.call, arguments: { command: "pwd" } } });
		expect(tracker.current().executable).toBe("pwd");
		expect(stableExecutableFromCommand("NODE_ENV=test npm run test", false)).toBe("npm");
		expect(stableExecutableFromCommand("pwd", false)).toBeUndefined();
	});

	it("晚到的 ID 和工具名更新同一调用，中止只清理对应消息", () => {
		const tracker = new PresenceActivityTracker();
		tracker.startTool("other", "read", { path: "previous.ts" });
		const stream = { messageKey: "message", contentIndex: 0 };
		tracker.stream({ ...stream, phase: "start", call: { id: "", name: "", arguments: {} } });
		tracker.stream({ ...stream, phase: "delta", delta: '{"path":"a', call: { id: "", name: "", arguments: {} } });
		tracker.stream({ ...stream, phase: "delta", delta: '.ts"', call: { id: "edit-1", name: "edit", arguments: {} } });
		expect(tracker.current()).toMatchObject({ kind: "editing", file: "a.ts" });
		tracker.startTool("edit-1", "edit", { path: "b.ts" });
		expect(tracker.current().file).toBe("a.ts");
		tracker.endTool("edit-1");
		expect(tracker.current().file).toBe("previous.ts");
		tracker.stream({ ...stream, phase: "start", call: { id: "new", name: "bash", arguments: {} } });
		tracker.abortMessage("message");
		expect(tracker.current().file).toBe("previous.ts");
	});

	it("只识别顶层完整 path，且空 basename 不回退到完整路径", () => {
		expect(completedTopLevelStringProperty('{"content":"{\\"path\\":\\"fake.ts\\"}","path":"src/a\\"b.ts"', "path")).toBe('src/a"b.ts');
		expect(completedTopLevelStringProperty('{"nested":{"path":"fake.ts"},"path":"real.ts"', "path")).toBe("real.ts");
		expect(completedTopLevelStringProperty('{"path":"src/partial', "path")).toBeUndefined();
		expect(classifyTool("read", { path: "/private/" })).not.toHaveProperty("file");
	});

	it("按 profile、模板和资源优先级渲染，并截断单行文本", () => {
		const config = enabledConfig();
		config.assets.large = { key: "pi_logo", text: "Pi\nCoding Agent" };
		config.assets.small.text = "{label}";
		config.assets.small.default = "default";
		config.assets.small.activities.editing = "edit";
		config.assets.small.languages.typescript = "ts";
		const session = { project: "o-pi", model: "GPT", session: "Presence", startedAt: 123 };
		const payload = renderDiscordActivity(config, configuredProfile(config, "detailed"), classifyTool("edit", { path: "/private/repo/example.ts" }), session);
		expect(payload).toEqual({
			details: "Editing example.ts", state: "o-pi · GPT", startTimestamp: 123,
			largeImageKey: "pi_logo", largeImageText: "Pi Coding Agent", smallImageKey: "ts", smallImageText: "TypeScript", instance: false,
		});
		expect(renderDiscordActivity(config, configuredProfile(config, "minimal"), classifyTool("edit", { path: "ignored.ts" }), session)).toBeUndefined();
		const profile = { details: { idle: "x".repeat(140) }, state: "", show_elapsed: false };
		expect(renderDiscordActivity(config, profile, { kind: "idle", tool: "" }, session)?.details).toHaveLength(128);
	});
});
