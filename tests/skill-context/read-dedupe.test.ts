import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { registerSkillReadDedupe } from "../../src/skill-context/index.js";
import { SKILL_CONTEXT_ENTRY, type SkillContextEntry } from "../../src/skill-context/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

let tempDir: string;
const temp = useTempDir("o-pi-skill-dedupe-");

beforeEach(() => {
	tempDir = temp.path;
});

describe("skill read dedupe", () => {
	it("已加载 skill 的 SKILL.md read 被 block", async () => {
		const skillPath = await writeSkill("demo");
		const handler = captureToolCallHandler();
		const result = await handler(readEvent(skillPath), fakeCtx([custom("1", activation("demo", skillPath))]));
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("already loaded") });
	});

	it("普通文件和 skill reference 文件不受影响", async () => {
		const skillPath = await writeSkill("demo");
		const referencePath = path.join(path.dirname(skillPath), "reference.md");
		await writeFile(referencePath, "reference\n");
		const handler = captureToolCallHandler();

		expect(await handler(readEvent(referencePath), fakeCtx([custom("1", activation("demo", skillPath))]))).toBeUndefined();
		expect(await handler(readEvent(path.join(tempDir, "other.md")), fakeCtx([custom("1", activation("demo", skillPath))]))).toBeUndefined();
	});

	it("路径比较使用 realpath/resolve 归一化", async () => {
		const skillPath = await writeSkill("demo");
		const relative = path.relative(tempDir, await realpath(skillPath));
		const handler = captureToolCallHandler();
		const result = await handler(readEvent(relative), fakeCtx([custom("1", activation("demo", skillPath))]));
		expect(result?.block).toBe(true);
	});
});

function captureToolCallHandler(): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> {
	let captured: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void) | undefined;
	const on = ((event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void) => {
		if (event === "tool_call") captured = handler;
	}) as Pick<ExtensionAPI, "on">["on"];
	registerSkillReadDedupe({
		on,
	});
	if (captured === undefined) throw new Error("tool_call handler not registered");
	return async (event, ctx) => captured?.(event, ctx);
}

async function writeSkill(name: string): Promise<string> {
	const dir = path.join(tempDir, name);
	await mkdir(dir);
	const skillPath = path.join(dir, "SKILL.md");
	await writeFile(skillPath, "skill\n");
	return skillPath;
}

function readEvent(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: filePath } };
}

function fakeCtx(branch: SessionEntry[]): ExtensionContext {
	return { cwd: tempDir, sessionManager: { getBranch: () => branch } } as never;
}

function custom(id: string, data: SkillContextEntry): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "t", customType: SKILL_CONTEXT_ENTRY, data };
}

function activation(name: string, skillPath: string): SkillContextEntry {
	return {
		kind: "activation",
		name,
		description: "desc",
		path: skillPath,
		baseDir: path.dirname(skillPath),
		body: "body",
		contentHash: "hash",
		scope: "task",
		loadedAt: "t",
	};
}
