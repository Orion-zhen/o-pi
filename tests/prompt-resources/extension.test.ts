import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPromptTemplates } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { beforeEach, describe, expect, it } from "vitest";
import agentsPromptsExtension from "../../agent/extensions/agents-prompts.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

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
const temp = useTempDir("o-pi-prompt-extension-");
preserveEnv("HOME");

beforeEach(() => {
	dir = temp.path;
	process.env.HOME = dir;
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
