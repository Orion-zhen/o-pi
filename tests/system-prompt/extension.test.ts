import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

import {
	buildRuntimeSystemPrompt,
	buildSubagentSystemPrompt,
	buildSystemPrompt,
	registerSystemCommand,
} from "../../agent/extensions/system-prompt.js";

preserveEnv("PI_SUBAGENT_CHILD", "PI_SUBAGENT_FORK", "PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE", "PI_SUBAGENT_FORK_MANIFEST", "PI_CODING_AGENT_DIR", "HOME");
const temp = useTempDir("o-pi-fork-system-prompt-");
let agentDir: string;

beforeEach(async () => {
	agentDir = temp.path;
	process.env.PI_CODING_AGENT_DIR = path.join(agentDir, "agent");
	process.env.HOME = agentDir;
	await mkdir(path.join(agentDir, "agent", "agents"), { recursive: true });
});

describe("system prompt extension", () => {
	it("各类 prompt 输入均可完成构建，但不把生成文案作为测试契约", async () => {
		const base: BuildSystemPromptOptions = {
			cwd: "/repo",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "read files", bash: "run commands" },
			promptGuidelines: ["Prefer direct tools."],
			contextFiles: [{ path: "AGENTS.md", content: "Project rule." }],
			appendSystemPrompt: "Append this.",
		};

		expect(buildSystemPrompt(base)).toEqual(expect.any(String));
		expect(buildSystemPrompt({ ...base, customPrompt: "Custom role." })).toEqual(expect.any(String));
		expect(buildSubagentSystemPrompt({
			...base,
			customPrompt: "---\nname: scout\ndescription: Inspect code\ntools: read, grep\n---\nReturn evidence.",
		})).toEqual(expect.any(String));
		await expect(buildRuntimeSystemPrompt(base, "/repo")).resolves.toEqual(expect.any(String));

		process.env.PI_SUBAGENT_CHILD = "1";
		await expect(buildRuntimeSystemPrompt({ ...base, customPrompt: "---\nname: scout\ndescription: Inspect code\n---\nBody." }, "/repo"))
			.resolves.toEqual(expect.any(String));
	});

	it("fork 子进程逐字读取父 system prompt 且不要求 Agent Markdown", async () => {
		const prompt = "Exact parent prompt.\n保留 Unicode 与换行。\n";
		const promptPath = path.join(temp.path, "prompt.txt");
		const manifestPath = path.join(temp.path, "manifest.json");
		await writeFile(promptPath, prompt);
		await writeFile(manifestPath, JSON.stringify({
			snapshotHash: "snapshot",
			systemPromptHash: createHash("sha256").update(prompt).digest("hex"),
			modelHash: "model",
			toolsHash: "tools",
			thinkingLevel: "medium",
			sessionId: "session",
			cwd: "/repo",
		}));
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FORK = "1";
		process.env.PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE = promptPath;
		process.env.PI_SUBAGENT_FORK_MANIFEST = manifestPath;

		await expect(buildRuntimeSystemPrompt({ cwd: "/different" }, "/different")).resolves.toBe(prompt);
	});

	it("子进程缺少 Agent Markdown 时拒绝启动", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		await expect(buildRuntimeSystemPrompt({ cwd: "/repo" }, "/repo")).rejects.toThrow("Subagent Agent Markdown is required");
	});

	it("subagent 工具不可用时，系统提示词不包含 <subagents> 信息", async () => {
		await writeFile(
			path.join(agentDir, "agent", "agents", "scout.md"),
			"---\nname: scout\ndescription: Scout agent\ntools: read, grep\n---\nScout body.",
		);

		const promptWithSubagent = await buildRuntimeSystemPrompt({ cwd: agentDir }, agentDir, true);
		expect(promptWithSubagent).toContain("<subagents>");
		expect(promptWithSubagent).toContain("scout");

		const promptWithoutSubagent = await buildRuntimeSystemPrompt({ cwd: agentDir }, agentDir, false);
		expect(promptWithoutSubagent).not.toContain("<subagents>");
	});

	it("/system 只通过只读浮层展示，不写入消息或编辑器", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandOptions: CommandOptions | undefined;
		let customCalled = false;
		let writeCalled = false;

		registerSystemCommand({
			registerCommand(_name, options) {
				commandOptions = options;
			},
		});

		await commandOptions?.handler("", {
			mode: "tui",
			hasUI: true,
			getSystemPromptOptions: () => ({ cwd: "/repo", selectedTools: ["read"] }),
			ui: {
				select: async () => undefined,
				editor: async () => {
					writeCalled = true;
					return undefined;
				},
				setEditorText: () => {
					writeCalled = true;
				},
				custom: async (factory: (tui: never, theme: never, keybindings: never, done: (result: void) => void) => unknown) => {
					customCalled = true;
					const viewer = factory(
						{ terminal: { rows: 30 } } as never,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
						{} as never,
						() => undefined,
					) as { render(width: number): string[]; handleInput(data: string): void };
					expect(viewer.render(80)).toEqual(expect.any(Array));
					viewer.handleInput("q");
					return undefined;
				},
			},
			sendMessage: () => {
				writeCalled = true;
			},
		} as never);

		expect(customCalled).toBe(true);
		expect(writeCalled).toBe(false);
	});
});
