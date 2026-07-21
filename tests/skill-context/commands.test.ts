import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, InputEvent, InputEventResult, SessionEntry, SlashCommandInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import skillContextExtension from "../../agent/extensions/skill-context.js";
import { registerSkillCommands } from "../../src/skill-context/commands.js";
import { SKILL_CONTEXT_ENTRY, SKILL_CONTEXT_MESSAGE, type SkillLoadEntry } from "../../src/skill-context/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-skill-command-");
let tempDir: string;

beforeEach(() => { tempDir = temp.path; });

describe("技能命令", () => {
	it("扩展注册一个静态工具、一个管理命令、渲染器和事件钩子", () => {
		const tools: Array<{ name: string; parameters: unknown }> = [];
		const commands: string[] = [];
		const renderers: string[] = [];
		const events: string[] = [];
		skillContextExtension({
			registerTool(tool: { name: string; parameters: unknown }) { tools.push(tool); },
			registerCommand(name: string) { commands.push(name); },
			registerMessageRenderer(type: string) { renderers.push(type); },
			on(name: string) { events.push(name); },
			getCommands: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			events: {},
		} as unknown as ExtensionAPI);

		expect(tools.map((tool) => tool.name)).toEqual(["skill"]);
		expect(JSON.stringify(tools[0]?.parameters)).not.toContain("enum");
		expect(commands).toEqual(["skill"]);
		expect(renderers).toEqual([SKILL_CONTEXT_MESSAGE]);
		expect(events).toEqual(expect.arrayContaining(["input", "tool_result"]));
		expect(events).not.toContain("context");
		expect(events).not.toContain("tool_call");
	});

	it("/skill:name 使用共享手动执行器且不触发模型轮次", async () => {
		const skillPath = await writeSkill("hidden", true);
		const entries: SkillLoadEntry[] = [];
		const messages: Array<{ content: unknown; options: unknown }> = [];
		let inputHandler: ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void>) | undefined;
		registerSkillCommands({
			registerCommand() {},
			appendEntry<T>(_type: string, entry?: T) { if (isSkillLoadEntry(entry)) entries.push(entry); },
			getCommands: () => [skillCommand("hidden", skillPath)],
			sendMessage(message, options) { messages.push({ content: message.content, options }); },
			on(event: string, handler: unknown) { if (event === "input") inputHandler = handler as typeof inputHandler; },
		});

		const result = await inputHandler?.({ type: "input", text: "/skill:hidden", source: "interactive" }, fakeCtx([]));
		expect(result).toEqual({ action: "handled" });
		expect(entries[0]).toMatchObject({ name: "hidden", loadedBy: "manual" });
		expect(entries[0]).not.toHaveProperty("disableModelInvocation");
		expect(messages).toEqual([{ content: '<invoked_skill root="skill://hidden"/>\n\nbody', options: { triggerTurn: false } }]);
	});

	it("skill 工具执行模型权限、写入分支记录并标记失败结果", async () => {
		const allowedPath = await writeSkill("allowed", false);
		const hiddenPath = await writeSkill("hidden", true);
		const branch: SessionEntry[] = [];
		let tool: ToolDefinition | undefined;
		const toolResultHandlers: Array<(event: { toolName: string; details: unknown }) => unknown> = [];
		let beforeAgentStart: ((event: { systemPromptOptions: BuildSystemPromptOptions }) => void) | undefined;
		const pi = {
			registerTool(value: ToolDefinition) { tool = value; },
			registerCommand() {},
			registerMessageRenderer() {},
			appendEntry<T>(_type: string, entry?: T) {
				if (!isSkillLoadEntry(entry)) return;
				branch.push({ type: "custom", id: String(branch.length + 1), parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data: entry });
			},
			getCommands: () => [skillCommand("allowed", allowedPath), skillCommand("hidden", hiddenPath)],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			events: {},
			on(name: string, handler: unknown) {
				if (name === "tool_result" && isToolResultHandler(handler)) toolResultHandlers.push(handler);
				if (name === "before_agent_start" && typeof handler === "function") beforeAgentStart = handler as typeof beforeAgentStart;
			},
		};
		skillContextExtension(pi as unknown as ExtensionAPI);
		if (tool === undefined) throw new Error("skill tool was not registered");
		beforeAgentStart?.({
			systemPromptOptions: {
				cwd: tempDir,
				skills: [piSkill("allowed", allowedPath, false), piSkill("hidden", hiddenPath, true)],
			},
		});

		const allowed = await tool.execute("skill-1", { name: "allowed" }, undefined, undefined, fakeCtx(branch));
		expect(allowed.content).toEqual([{ type: "text", text: '<invoked_skill root="skill://allowed"/>\n\nbody' }]);
		expect(allowed.details).toMatchObject({ name: "allowed", loadedBy: "agent", deduplicated: false });
		expect(branch).toHaveLength(1);

		const hidden = await tool.execute("skill-2", { name: "hidden" }, undefined, undefined, fakeCtx(branch));
		expect(hidden.details).toMatchObject({ status: "failed", error: { code: "SKILL_NOT_LOADABLE" } });
		expect(toolResultHandlers.some((handler) => {
			const result = handler({ toolName: "skill", details: hidden.details });
			return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
		})).toBe(true);
	});

	it("/skill clear 不再执行清理", async () => {
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const notify = vi.fn();
		registerSkillCommands({
			registerCommand(_name, options) { handler = options.handler as typeof handler; },
			appendEntry() { throw new Error("must not append"); },
			getCommands: () => [], sendMessage() {}, on() {},
		});
		await handler?.("clear", { ui: { notify }, sessionManager: { getBranch: () => [] } } as never);
		expect(notify).toHaveBeenCalledWith("usage: /skill", "warning");
	});
});

async function writeSkill(name: string, disableModelInvocation: boolean): Promise<string> {
	const dir = path.join(tempDir, name);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	await writeFile(file, `---\nname: ${name}\ndescription: desc\ndisable-model-invocation: ${disableModelInvocation}\n---\nbody\n`);
	return file;
}

function skillCommand(name: string, file: string): SlashCommandInfo {
	return { name: `skill:${name}`, description: "desc", source: "skill", sourceInfo: { path: file, source: "project", scope: "project", origin: "top-level" } };
}

function piSkill(name: string, filePath: string, disableModelInvocation: boolean): NonNullable<BuildSystemPromptOptions["skills"]>[number] {
	return {
		name,
		description: "desc",
		filePath,
		baseDir: path.dirname(filePath),
		disableModelInvocation,
		sourceInfo: { path: filePath, source: "project", scope: "project", origin: "top-level" },
	};
}

function fakeCtx(branch: SessionEntry[]): ExtensionContext {
	return { sessionManager: { getBranch: () => branch }, ui: { notify: vi.fn() } } as never;
}

function isSkillLoadEntry(value: unknown): value is SkillLoadEntry {
	return typeof value === "object" && value !== null && "loadedBy" in value;
}

function isToolResultHandler(value: unknown): value is (event: { toolName: string; details: unknown }) => unknown {
	return typeof value === "function";
}
