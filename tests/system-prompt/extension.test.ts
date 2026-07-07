import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(import("os"), async (importOriginal) => ({
	...(await importOriginal()),
	type: () => "Linux",
	release: () => "7.1.2-arch",
}));

import { buildSystemPrompt, registerSystemCommand, SystemPromptViewer } from "../../agent/extensions/system-prompt.js";

const toolSnippets = {
	read: "read files",
	bash: "run commands",
};

describe("system prompt extension", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("生成结构化 prompt，但不泄露未启用工具和 skill 元数据", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00Z"));

		const options: BuildSystemPromptOptions = {
			cwd: "C:\\repo",
			selectedTools: ["read", "bash"],
			toolSnippets,
			promptGuidelines: ["Prefer direct tools.", "Prefer direct tools."],
			contextFiles: [{ path: "AGENTS.md", content: "Project rule.\r\nSecond line." }],
			skills: [
				{
					name: "secret-skill",
					description: "Hidden skill description.",
					filePath: "C:\\repo\\.pi\\skills\\secret\\SKILL.md",
					baseDir: "C:\\repo\\.pi\\skills\\secret",
					disableModelInvocation: false,
					sourceInfo: {
						path: "C:\\repo\\.pi\\skills\\secret\\SKILL.md",
						source: "project",
						scope: "project",
						origin: "top-level",
						baseDir: "C:\\repo\\.pi\\skills\\secret",
					},
				},
			],
		};

		const prompt = buildSystemPrompt(options);

		expect(prompt).not.toContain("\r");
		expect(prompt).toContain("<tool_policy>");
		expect(prompt).toContain("<skill_policy>");
		expect(prompt).toContain("<available_tools>");
		expect(prompt).toContain("<project_context>");
		expect(prompt).toContain("<context>");
		expect(prompt).toContain("<time>2026-07-05</time>");
		expect(prompt).toContain("<workspace>C:/repo</workspace>");
		expect(prompt).toContain("- read: read files");
		expect(prompt).toContain("- bash: run commands");
		expect(prompt).not.toContain("write:");
		expect(prompt).not.toContain("secret-skill");
		expect(prompt).not.toContain("Hidden skill description.");
		expect(prompt).not.toContain("C:\\repo\\.pi\\skills\\secret\\SKILL.md");
		expect(prompt.match(/Prefer direct tools\./g)).toHaveLength(1);
	});

	it("没有可用 skill 时不输出 skill_policy", () => {
		const prompt = buildSystemPrompt({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets,
		});

		expect(prompt).not.toContain("<skill_policy>");
	});

	it("customPrompt 替换默认角色，同时保留 append、工具和上下文段落", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\repo",
			customPrompt: "Only this base prompt.",
			selectedTools: ["read"],
			toolSnippets,
			skills: [
				{
					name: "demo",
					description: "Hidden skill description.",
					filePath: "/repo/skills/demo/SKILL.md",
					baseDir: "/repo/skills/demo",
					disableModelInvocation: false,
					sourceInfo: {
						path: "/repo/skills/demo/SKILL.md",
						source: "project",
						scope: "project",
						origin: "top-level",
						baseDir: "/repo/skills/demo",
					},
				},
			],
			appendSystemPrompt: "Append this.",
		});

		expect(prompt).toContain("<custom_prompt>\nOnly this base prompt.\n</custom_prompt>");
		expect(prompt).toContain("<skill_policy>");
		expect(prompt).toContain("<append_system_prompt>\nAppend this.\n</append_system_prompt>");
		expect(prompt).toContain("<available_tools>");
		expect(prompt).toContain("- read: read files");
		expect(prompt).toContain("<context>");
		expect(prompt).not.toContain("<role>");
	});

	it("注册 /system 命令并用只读 custom UI 展示当前构建结果", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;
		let customLines: string[] | undefined;
		let sendMessageCalled = false;
		let editorCalled = false;
		let setEditorTextCalled = false;
		let customCalled = false;

		registerSystemCommand({
			registerCommand(name, options) {
				commandName = name;
				commandOptions = options;
			},
		});

		expect(commandName).toBe("system");
		expect(commandOptions?.handler).toEqual(expect.any(Function));
		await commandOptions?.handler("", {
			mode: "tui",
			hasUI: true,
			getSystemPrompt: () => "Pi built-in prompt should not be displayed.",
			getSystemPromptOptions: () => ({
				cwd: "C:\\repo",
				selectedTools: ["read"],
				toolSnippets,
			}),
			ui: {
				select: async (_title: string, options: string[]) => {
					throw new Error(`select should not be used: ${options.length}`);
				},
				editor: async () => {
					editorCalled = true;
					return undefined;
				},
				setEditorText: () => {
					setEditorTextCalled = true;
				},
				custom: async (factory: (tui: never, theme: never, keybindings: never, done: (result: void) => void) => Promise<{ render(width: number): string[] }> | { render(width: number): string[] }) => {
					customCalled = true;
					const theme = {
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					};
					const component = await factory({ terminal: { rows: 30 } } as never, theme as never, {} as never, () => undefined);
					customLines = component.render(80);
					return undefined;
				},
			},
			sendMessage: () => {
				sendMessageCalled = true;
			},
		} as never);

		expect(customCalled).toBe(true);
		expect(customLines?.[0]).toMatch(/System prompt \(\d+ chars, ~\d+ tokens, \d+ lines\)/);
		expect(customLines?.some((line) => line.includes("<available_tools>"))).toBe(true);
		expect(customLines?.some((line) => line.includes("Pi built-in prompt"))).toBe(false);
		expect(sendMessageCalled).toBe(false);
		expect(editorCalled).toBe(false);
		expect(setEditorTextCalled).toBe(false);
	});

	it("system prompt 查看器对中文内容保持固定行宽", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const content = [
			"<project_instructions>",
			"# AGENTS.md",
			"## 项目目标",
			"项目基于 Pi Coding Agent 构建个人专属 Agent，包括扩展、工具、命令、技能、提示词及相关配置。",
			"用户不负责 TypeScript 开发。你必须主动完成分析、设计、实现、重构、验证和文档更新，不得把代码修改工作转交给用户。",
			"本文件夹即会作为 `~/.pi`",
			"</project_instructions>",
		].join("\r\n");
		const viewer = new SystemPromptViewer(content, theme as never, () => 20, () => undefined);
		const width = 80;
		const rendered = viewer.render(width);

		expect(rendered.length).toBeGreaterThan(5);
		expect(rendered[0]).toMatch(/System prompt \(\d+ chars, ~\d+ tokens, \d+ lines\)/);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBe(width);
			expect(line).not.toContain("\r");
		}
		expect(rendered.some((line) => line.includes("# AGENTS.md"))).toBe(true);
		expect(rendered.some((line) => line.includes("## 项目目标"))).toBe(true);
		expect(rendered.some((line) => line.includes("用户不负责"))).toBe(true);
	});
});
