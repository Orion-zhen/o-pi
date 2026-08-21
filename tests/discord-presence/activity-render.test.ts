import { describe, expect, it } from "vitest";
import {
	classifyTool,
	currentActivity,
	endTool,
	initialPresenceActivityState,
	stableExecutableFromCommand,
	startTool,
	startTurn,
	updateTool,
} from "../../src/discord-presence/activity.js";
import { renderDiscordActivity, renderTemplate } from "../../src/discord-presence/render.js";
import {
	completedTopLevelStringProperty,
	StreamingToolCallTracker,
} from "../../src/discord-presence/streaming.js";
import { enabledConfig } from "./fixtures.js";

describe("Discord presence 活动与渲染", () => {
	it.each([
		["read", { path: "/repo/src/main.ts" }, { kind: "reading", file: "main.ts", language: "TypeScript" }],
		["edit", { path: "README.md" }, { kind: "editing", file: "README.md", language: "Markdown" }],
		["write", { path: "main.rs" }, { kind: "writing", file: "main.rs", language: "Rust" }],
		["grep", { query: "secret" }, { kind: "searching" }],
		["websearch", { query: "private query" }, { kind: "browsing" }],
		["bash", { command: "TOKEN=x /usr/bin/git status --secret" }, { kind: "shell", executable: "git" }],
		["custom", { value: "private" }, { kind: "other_tool", tool: "custom" }],
	] as const)("将 %s 分类且只保留安全目标", (tool, args, expected) => {
		expect(classifyTool(tool, args)).toMatchObject(expected);
	});

	it("并行工具按 toolCallId 恢复上一活动，并在无工具时回到思考", () => {
		let state = startTurn(initialPresenceActivityState());
		state = startTool(state, "read-1", "read", { path: "a.ts" });
		state = startTool(state, "bash-1", "bash", { command: "npm test" });
		expect(currentActivity(state)).toMatchObject({ kind: "shell", executable: "npm" });
		state = endTool(state, "bash-1");
		expect(currentActivity(state)).toMatchObject({ kind: "reading", file: "a.ts" });
		state = endTool(state, "read-1");
		expect(currentActivity(state)).toMatchObject({ kind: "thinking" });
	});

	it("只在 path 字符串闭合和首个 Shell word 完成后 one-shot 提取元数据", () => {
		const fileTracker = new StreamingToolCallTracker();
		fileTracker.start("message", 0, { id: "write-1", name: "write", arguments: {} });
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/ind" },
		}, '{"path":"/private/src/ind')).toBeUndefined();
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/index.ts" },
		}, 'ex.ts","content":"{\\"path\\":\\"fake.ts\\"}')).toMatchObject({
			toolCallId: "write-1",
			args: { path: "/private/src/index.ts" },
		});
		expect(fileTracker.delta("message", 0, {
			id: "write-1", name: "write", arguments: { path: "/private/src/index.ts" },
		}, " more content")).toBeUndefined();

		const shellTracker = new StreamingToolCallTracker();
		shellTracker.start("message", 1, { id: "bash-1", name: "bash", arguments: {} });
		expect(shellTracker.delta("message", 1, {
			id: "bash-1", name: "bash", arguments: { command: "NODE_ENV=test np" },
		}, '{"command":"NODE_ENV=test np')).toBeUndefined();
		expect(shellTracker.delta("message", 1, {
			id: "bash-1", name: "bash", arguments: { command: "NODE_ENV=test npm run test" },
		}, "m run test")).toMatchObject({ args: { command: "NODE_ENV=test npm run test" } });
		expect(stableExecutableFromCommand("NODE_ENV=test npm run test", false)).toBe("npm");
		expect(stableExecutableFromCommand("pwd", false)).toBeUndefined();
		expect(stableExecutableFromCommand("pwd", true)).toBe("pwd");
	});

	it("流式 ID 替换和执行兜底不会覆盖已稳定的文件名", () => {
		let state = startTurn(initialPresenceActivityState());
		state = updateTool(state, "stream:message:0", "stream:message:0", "edit", {});
		state = updateTool(state, "stream:message:0", "edit-1", "edit", { path: "/private/a.ts" });
		state = startTool(state, "edit-1", "edit", { path: "/private/b.ts" });
		expect(currentActivity(state)).toMatchObject({ kind: "editing", file: "a.ts", language: "TypeScript" });
	});

	it("只识别顶层完整 path，且空 basename 不回退到完整路径", () => {
		expect(completedTopLevelStringProperty(
			'{"content":"{\\"path\\":\\"fake.ts\\"}","path":"src/a\\"b.ts"',
			"path",
		)).toBe('src/a"b.ts');
		expect(completedTopLevelStringProperty('{"path":"src/partial', "path")).toBeUndefined();
		expect(classifyTool("read", { path: "/private/" })).not.toHaveProperty("file");
	});

	it("按 profile、模板和资源优先级渲染，并安全截断单行文本", () => {
		const config = enabledConfig();
		config.assets.large = { key: "pi_logo", text: "Pi\nCoding Agent" };
		config.assets.small.text = "{label}";
		config.assets.small.default = "default";
		config.assets.small.activities.editing = "edit";
		config.assets.small.languages.typescript = "ts";
		const payload = renderDiscordActivity(
			config,
			"detailed",
			classifyTool("edit", { path: "/private/repo/example.ts" }),
			{ project: "o-pi", model: "GPT", session: "Presence", startedAt: 123 },
		);

		expect(payload).toEqual({
			details: "Editing example.ts",
			state: "o-pi · GPT",
			startTimestamp: 123,
			largeImageKey: "pi_logo",
			largeImageText: "Pi Coding Agent",
			smallImageKey: "ts",
			smallImageText: "TypeScript",
			instance: false,
		});
		expect(renderDiscordActivity(
			config,
			"minimal",
			classifyTool("edit", { path: "ignored.ts" }),
			{ project: "o-pi", model: "GPT", session: "Presence", startedAt: 123 },
		)).toBeUndefined();
		expect(renderTemplate("x".repeat(140), {
			project: "", model: "", session: "", file: "", language: "", executable: "", tool: "", label: "",
		})).toHaveLength(128);
	});
});

