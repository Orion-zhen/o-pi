import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSessionProjection, createEventBus, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type InputEvent, type InputEventResult, type SessionEntry, type SlashCommandInfo, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import skillContextExtension from "../../../src/harness/extensions/skill-context.ts";
import { registerSkillCommands } from "../../../src/harness/skill-context/commands.ts";
import { SKILL_CONTEXT_ENTRY, type SkillLoadEntry } from "../../../src/harness/skill-context/types.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { registerExtension } from "../../helpers/extension.ts";

const temp = useTempDir("o-pi-skill-command-");
let tempDir: string;

beforeEach(() => { tempDir = temp.path; });

describe("技能命令", () => {
	it("业务扩展只注册静态工具、管理命令和事件钩子", () => {
		const { registered: tools, commands, handlers } = registerExtension(skillContextExtension);
		expect(tools.map((tool) => tool.name)).toEqual(["skill"]);
		expect(JSON.stringify(tools[0]?.parameters)).not.toContain("enum");
		expect(tools[0]?.renderCall).toBeUndefined();
		expect([...commands.keys()]).toEqual(["skill"]);
		expect(handlers.has("input")).toBe(true);
		for (const event of ["session_start", "tool_result", "context", "tool_call"]) expect(handlers.has(event)).toBe(false);
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
			on(event: string, handler: unknown) {
				if (event === "input") inputHandler = handler as typeof inputHandler;
				return () => {};
			},
		});

		const result = await inputHandler?.({ type: "input", text: "/skill:hidden", source: "interactive" }, fakeCtx([]));
		expect(result).toEqual({ action: "handled" });
		expect(entries[0]).toMatchObject({ name: "hidden", loadedBy: "manual" });
		expect(entries[0]).not.toHaveProperty("disableModelInvocation");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.options).toEqual({ triggerTurn: false });
	});

	it("skill 工具执行模型权限、写入分支记录并标记失败结果", async () => {
		const allowedPath = await writeSkill("allowed", false);
		const hiddenPath = await writeSkill("hidden", true);
		const branch: SessionEntry[] = [];
		let tool: ToolDefinition | undefined;
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
			events: createEventBus(),
			on(name: string, handler: unknown) {
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
		expect(allowed.details).toMatchObject({ name: "allowed", loadedBy: "agent", deduplicated: false });
		expect(branch).toHaveLength(1);

		const hidden = await tool.execute("skill-2", { name: "hidden" }, undefined, undefined, fakeCtx(branch));
		expect(hidden.details).toMatchObject({ status: "failed", error: { code: "SKILL_NOT_LOADABLE" } });
		expect(hidden.isError).toBe(true);
		expect(tool.exposure).toBe("model-only");

		const resourcePath = "skill://allowed/references/testing.md";
		const resource = await tool.execute("skill-3", { name: resourcePath }, undefined, undefined, fakeCtx(branch));
		expect(resource.details).toMatchObject({ status: "failed", error: { code: "SKILL_PATH_USE_FILESYSTEM" } });
		expect(resource.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`filesystem tool with path "${resourcePath}"`) });
		expect(branch).toHaveLength(1);
	});

	it("/skill clear 不再执行清理", async () => {
		let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const notify = vi.fn();
		registerSkillCommands({
			registerCommand(_name, options) { handler = options.handler as typeof handler; },
			appendEntry() { throw new Error("must not append"); },
			getCommands: () => [], sendMessage() {}, on() { return () => {}; },
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

function fakeCtx(branch: SessionEntry[]): ExtensionToolContext {
	return {
		tools: [],
		executeTool: async () => { throw new Error("No nested tools registered"); },
		sessionManager: {
			getBranch: () => branch,
			buildSessionProjection: () => buildSessionProjection(branch),
		},
		ui: { notify: vi.fn() },
	} as never;
}

function isSkillLoadEntry(value: unknown): value is SkillLoadEntry {
	return typeof value === "object" && value !== null && "loadedBy" in value;
}
