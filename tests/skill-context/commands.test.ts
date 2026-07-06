import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	RegisteredCommand,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionEntry,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSkill, loadSkillCommand, registerSkillCommands } from "../../src/skill-context/commands.js";
import { defaultSkillContextConfig } from "../../src/skill-context/config.js";
import { SKILL_CONTEXT_ENTRY, SKILL_CONTEXT_STATUS_MESSAGE, type SkillContextEntry, type SkillContextStatusMessage } from "../../src/skill-context/types.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), "o-pi-skill-command-"));
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(tempDir, { recursive: true, force: true });
});

describe("skill commands", () => {
	it("只注册 /skill 管理命令，/skill:name 由 input hook 接管避免命令列表重复", async () => {
		const skillPath = await writeSkill("demo", "body");
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		const registered: string[] = [];
		let inputHandler: ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void> | InputEventResult | void) | undefined;
		const pi = {
			registerCommand(name: string) {
				registered.push(name);
			},
			appendEntry<T>(_customType: string, data?: T) {
				if (data !== undefined) entries.push(data as SkillContextEntry);
			},
			sendMessage<T>(message: { customType: string; details?: T }) {
				if (message.customType === SKILL_CONTEXT_STATUS_MESSAGE && message.details !== undefined) {
					messages.push(message.details as SkillContextStatusMessage);
				}
			},
			getCommands: () => [skillCommand("skill:demo", skillPath)],
			on(event: string, handler: unknown) {
				if (event === "input") inputHandler = handler as typeof inputHandler;
			},
		};

		registerSkillCommands(pi as never);
		expect(registered).toEqual(["skill"]);
		expect(inputHandler).toEqual(expect.any(Function));

		const result = await inputHandler?.({ type: "input", text: "/skill:demo", source: "interactive" }, fakeInputCtx([], vi.fn()));
		expect(result).toEqual({ action: "handled" });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "activation", name: "demo" });
		expect(messages).toEqual([{ action: "loaded", name: "demo", chars: 4, path: skillPath }]);
	});

	it("/skill:clear 可作为 skill 名加载，不与管理命令冲突", async () => {
		const skillPath = await writeSkill("clear", "body");
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		let inputHandler: ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void> | InputEventResult | void) | undefined;
		const pi = {
			registerCommand() {},
			appendEntry<T>(_customType: string, data?: T) {
				if (data !== undefined) entries.push(data as SkillContextEntry);
			},
			sendMessage<T>(message: { customType: string; details?: T }) {
				if (message.customType === SKILL_CONTEXT_STATUS_MESSAGE && message.details !== undefined) {
					messages.push(message.details as SkillContextStatusMessage);
				}
			},
			getCommands: () => [skillCommand("skill:clear", skillPath)],
			on(event: string, handler: unknown) {
				if (event === "input") inputHandler = handler as typeof inputHandler;
			},
		};

		registerSkillCommands(pi as never);
		const result = await inputHandler?.({ type: "input", text: "/skill:clear", source: "interactive" }, fakeInputCtx([], vi.fn()));
		expect(result).toEqual({ action: "handled" });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "activation", name: "clear" });
		expect(messages).toEqual([{ action: "loaded", name: "clear", chars: 4, path: skillPath }]);
	});

	it("/skill clear 通过管理命令执行清理", async () => {
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		let handler: RegisteredCommand["handler"] | undefined;
		registerSkillCommands({
			registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
				if (name === "skill") handler = options.handler;
			},
			appendEntry<T>(_customType: string, data?: T) {
				if (data !== undefined) entries.push(data as SkillContextEntry);
			},
			sendMessage<T>(message: { customType: string; details?: T }) {
				if (message.customType === SKILL_CONTEXT_STATUS_MESSAGE && message.details !== undefined) {
					messages.push(message.details as SkillContextStatusMessage);
				}
			},
			getCommands: () => [],
			on() {},
		} as never);

		await handler?.("clear demo", fakeCtx([], vi.fn()));
		expect(entries).toEqual([{ kind: "deactivation", name: "demo", mode: "lazy", reason: "user_clear", clearedAt: "2026-07-06T00:00:00.000Z" }]);
		expect(messages).toEqual([{ action: "inactive", name: "demo", mode: "lazy" }]);
	});

	it("/skill:demo append activation entry 和状态卡片，不调用 prompt/model API", async () => {
		const skillPath = await writeSkill("demo", "body");
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		const notify = vi.fn();
		await loadSkillCommand(fakePi(entries, [skillCommand("skill:demo", skillPath)], messages), "demo", fakeCtx([], notify), defaultSkillContextConfig());

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "activation", name: "demo", body: "body", loadedAt: "2026-07-06T00:00:00.000Z" });
		expect(messages).toEqual([{ action: "loaded", name: "demo", chars: 4, path: skillPath }]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("/skill clear append deactivation entry", async () => {
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		const notify = vi.fn();
		await clearSkill(fakePi(entries, [], messages), "demo", fakeCtx([], notify), defaultSkillContextConfig());

		expect(entries).toEqual([{ kind: "deactivation", name: "demo", mode: "lazy", reason: "user_clear", clearedAt: "2026-07-06T00:00:00.000Z" }]);
		expect(messages).toEqual([{ action: "inactive", name: "demo", mode: "lazy" }]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("unknown skill 只 notify error，不 append", async () => {
		const entries: SkillContextEntry[] = [];
		const notify = vi.fn();
		await loadSkillCommand(fakePi(entries, [], []), "missing", fakeCtx([], notify), defaultSkillContextConfig());

		expect(entries).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith("skill missing not found", "error");
	});

	it("config disabled 时命令提示 disabled", async () => {
		const skillPath = await writeSkill("demo", "body");
		const entries: SkillContextEntry[] = [];
		const notify = vi.fn();
		await loadSkillCommand(fakePi(entries, [skillCommand("skill:demo", skillPath)], []), "demo", fakeCtx([], notify), {
			...defaultSkillContextConfig(),
			enabled: false,
		});

		expect(entries).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith("skill context disabled", "warning");
	});

	it("max_active=1 replace 时 append old deactivation + new activation", async () => {
		const skillPath = await writeSkill("new", "new body");
		const entries: SkillContextEntry[] = [];
		const messages: SkillContextStatusMessage[] = [];
		const branch = [custom("1", activation("old"))];
		await loadSkillCommand(fakePi(entries, [skillCommand("skill:new", skillPath)], messages), "new", fakeCtx(branch, vi.fn()), {
			...defaultSkillContextConfig(),
			max_active: 1,
			on_load_conflict: "replace",
		});

		expect(entries.map((entry) => entry.kind)).toEqual(["deactivation", "activation"]);
		expect(entries[0]).toMatchObject({ kind: "deactivation", name: "old", reason: "conflict_replace" });
		expect(entries[1]).toMatchObject({ kind: "activation", name: "new" });
		expect(messages).toEqual([{ action: "loaded", name: "new", chars: 8, path: skillPath }]);
	});

	it("重复加载同一个 active skill 时不追加 conflict deactivation", async () => {
		const skillPath = await writeSkill("demo", "new body");
		const entries: SkillContextEntry[] = [];
		const branch = [custom("1", activation("demo"))];
		await loadSkillCommand(fakePi(entries, [skillCommand("skill:demo", skillPath)]), "demo", fakeCtx(branch, vi.fn()), {
			...defaultSkillContextConfig(),
			max_active: 1,
			on_load_conflict: "replace",
		});

		expect(entries.map((entry) => entry.kind)).toEqual(["activation"]);
		expect(entries[0]).toMatchObject({ kind: "activation", name: "demo", body: "new body" });
	});
});

async function writeSkill(name: string, body: string): Promise<string> {
	const dir = path.join(tempDir, name);
	await mkdir(dir);
	const skillPath = path.join(dir, "SKILL.md");
	await writeFile(skillPath, `---\nname: ${name}\ndescription: desc\n---\n${body}\n`);
	return skillPath;
}

function fakePi(
	entries: SkillContextEntry[],
	commands: SlashCommandInfo[],
	messages: SkillContextStatusMessage[] = [],
): Pick<ExtensionAPI, "appendEntry" | "getCommands" | "sendMessage"> {
	return {
		appendEntry<T>(_customType: string, data?: T) {
			if (data !== undefined) entries.push(data as SkillContextEntry);
		},
		sendMessage<T>(message: { customType: string; details?: T }) {
			if (message.customType === SKILL_CONTEXT_STATUS_MESSAGE && message.details !== undefined) {
				messages.push(message.details as SkillContextStatusMessage);
			}
		},
		getCommands: () => commands,
	};
}

function fakeCtx(branch: SessionEntry[], notify: ReturnType<typeof vi.fn>): ExtensionCommandContext {
	return {
		cwd: tempDir,
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		getSystemPromptOptions: (): BuildSystemPromptOptions => ({ cwd: tempDir }),
		ui: { notify },
	} as never;
}

function fakeInputCtx(branch: SessionEntry[], notify: ReturnType<typeof vi.fn>): ExtensionContext {
	return {
		cwd: tempDir,
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: { notify },
	} as never;
}

function skillCommand(name: string, filePath: string): SlashCommandInfo {
	return {
		name,
		description: "desc",
		source: "skill",
		sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level" },
	};
}

function custom(id: string, data: SkillContextEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}

function activation(name: string): SkillContextEntry {
	return {
		kind: "activation",
		name,
		description: "desc",
		path: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		body: "old body",
		contentHash: "hash",
		scope: "task",
		loadedAt: "t",
	};
}
