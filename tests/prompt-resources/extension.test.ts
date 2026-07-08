import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPromptTemplates } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import agentsPromptsExtension from "../../agent/extensions/agents-prompts.js";

interface ResourcesEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

interface ResourcesContext {
	isProjectTrusted(): boolean;
}

interface ResourcesResult {
	promptPaths?: string[];
}

type ResourcesHandler = (event: ResourcesEvent, ctx: ResourcesContext) => ResourcesResult | Promise<ResourcesResult>;

let dir: string;
const oldHome = process.env.HOME;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-prompt-extension-"));
	process.env.HOME = dir;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
});

describe("agents prompts extension", () => {
	it("通过 resources_discover 暴露 prompt template 文件", async () => {
		const prompt = path.join(dir, ".agents", "prompts", "ask.md");
		await mkdir(path.dirname(prompt), { recursive: true });
		await writeFile(prompt, "---\ndescription: Ask something\nargument-hint: <topic>\n---\nAsk about $1");

		let handler: ResourcesHandler | undefined;
		agentsPromptsExtension({
			on: ((event: string, candidate: ResourcesHandler) => {
				if (event === "resources_discover") handler = candidate;
			}) as ExtensionAPI["on"],
		});

		const result = await handler?.(
			{ type: "resources_discover", cwd: dir, reason: "startup" },
			{ isProjectTrusted: () => false },
		);
		expect(result?.promptPaths).toEqual([prompt]);

		const templates = loadPromptTemplates({
			cwd: dir,
			agentDir: path.join(dir, "agent"),
			promptPaths: result?.promptPaths ?? [],
			includeDefaults: false,
		});
		const slashCommands = templates.map((template) => ({
			name: template.name,
			description: template.description,
		}));
		expect(slashCommands).toEqual([{ name: "ask", description: "Ask something" }]);
	});
});
