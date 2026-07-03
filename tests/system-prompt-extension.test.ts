import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { buildSystemPrompt, registerSystemCommand, SystemPromptViewer } from "../agent/extensions/system-prompt.js";

describe("system prompt extension", () => {
	it("用 XML 风格保留 Pi 默认信息来源但不加入 skill 元数据", () => {
		const options: BuildSystemPromptOptions = {
			cwd: "C:\\repo",
			selectedTools: ["read", "bash"],
			toolSnippets: {
				read: "Read files",
				bash: "Run shell commands",
			},
			promptGuidelines: ["Use read before edit."],
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

		expect(prompt).toContain("<role>");
		expect(prompt).toContain("<tools>");
		expect(prompt).toContain("- read: Read files");
		expect(prompt).toContain("<tool_guidelines>");
		expect(prompt).toContain("Use read before edit.");
		expect(prompt).toContain("<project_context>");
		expect(prompt).toContain("Project rule.\nSecond line.");
		expect(prompt).not.toContain("\r");
		expect(prompt).toContain("<context>");
		expect(prompt).toContain("<workspace>C:/repo</workspace>");
		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).not.toContain("secret-skill");
		expect(prompt).not.toContain("Hidden skill description.");
	});

	it("customPrompt 按 Pi 语义替换默认角色和工具段", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\repo",
			customPrompt: "Only this base prompt.",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			appendSystemPrompt: "Append this.",
		});

		expect(prompt).toContain("<custom_prompt>\nOnly this base prompt.\n</custom_prompt>");
		expect(prompt).toContain("<append_system_prompt>\nAppend this.\n</append_system_prompt>");
		expect(prompt).toContain("<context>");
		expect(prompt).not.toContain("<role>");
		expect(prompt).not.toContain("<tools>");
		expect(prompt).not.toContain("Read files");
	});

	it("注册 /system 命令并用只读 custom UI 展示", async () => {
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
		expect(commandOptions?.description).toBe("Show the current synthesized system prompt.");
		expect(commandOptions?.handler).toEqual(expect.any(Function));
		await commandOptions?.handler("", {
			mode: "tui",
			hasUI: true,
			getSystemPrompt: () => "Pi built-in prompt should not be displayed.",
			getSystemPromptOptions: () => ({
				cwd: "C:\\repo",
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
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
					const component = await factory({ terminal: { rows: 20 } } as never, theme as never, {} as never, () => undefined);
					customLines = component.render(80);
					return undefined;
				},
			},
			sendMessage: () => {
				sendMessageCalled = true;
			},
		} as never);

		expect(customCalled).toBe(true);
		expect(customLines?.some((line) => line.includes("<role>"))).toBe(true);
		expect(customLines?.some((line) => line.includes("Read files"))).toBe(true);
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
		for (const line of rendered) {
			expect(visibleWidth(line)).toBe(width);
			expect(line).not.toContain("\r");
		}
		expect(rendered.some((line) => line.includes("# AGENTS.md"))).toBe(true);
		expect(rendered.some((line) => line.includes("## 项目目标"))).toBe(true);
		expect(rendered.some((line) => line.includes("用户不负责"))).toBe(true);
	});
});
