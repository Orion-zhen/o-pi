import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	initTheme, SessionManager,
	type AgentSessionRuntime, type ExtensionContext, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createTuiExtensions } from "../../src/tui/extensions.ts";
import { SKILL_CONTEXT_MESSAGE } from "../../src/harness/skill-context/types.ts";
import { SUBAGENT_COMMAND_ENTRY } from "../../src/harness/subagent/constants.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-tool-renderers-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
const toolNames = ["ls", "find", "grep", "read", "write", "edit", "bash", "websearch", "webfetch", "skill", "subagent"];
const extensionNames = new Set(["file-tools", "bash-tool", "web-tools", "skill-context", "subagent", "tool-renderers"]);
let runtime: AgentSessionRuntime | undefined;

beforeAll(() => initTheme());
beforeEach(async () => {
	setTestHome(temp.path);
	process.env.PI_CODING_AGENT_DIR = path.join(temp.path, "agent");
	process.env.PI_OFFLINE = "1";
	await mkdir(process.env.PI_CODING_AGENT_DIR);
	await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultTools: toolNames }));
});
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

async function start() {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: createTuiExtensions().filter((extension) => extensionNames.has(extension.name)),
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd: temp.path, agentDir: path.join(temp.path, "agent"), sessionManager: SessionManager.inMemory(temp.path) });
	return runtime.session;
}

it("TUI 渲染器独立于执行定义，启动和恢复不重新注册工具", async () => {
	const session = await start();
	const definitions = toolNames.map((name) => session.getToolDefinition(name));
	expect(definitions.every((definition) => definition !== undefined)).toBe(true);
	const active = session.getActiveToolNames();
	await session.bindExtensions({ mode: "tui", onError: ({ error }) => { throw new Error(error); } });
	for (const [index, name] of toolNames.entries()) {
		expect(session.getToolDefinition(name), name).toBe(definitions[index]);
		expect(session.getToolDefinition(name)?.renderCall, name).toBeUndefined();
		expect(session.getToolDefinition(name)?.renderResult, name).toBeUndefined();
		const renderers = session.extensionRunner.resolveToolRenderers(name, () => undefined);
		expect(renderers?.renderCall, name).toBeTypeOf("function");
		if (name !== "bash") expect(renderers?.renderResult, name).toBeTypeOf("function");
	}
	expect(session.getActiveToolNames()).toEqual(active);
	expect(session.extensionRunner.resolveToolRenderers("edit", () => undefined)?.renderShell).toBe("self");
	expect(session.extensionRunner.getMessageRenderer(SKILL_CONTEXT_MESSAGE)).toBeTypeOf("function");
	expect(session.extensionRunner.getEntryRenderer(SUBAGENT_COMMAND_ENTRY)).toBeTypeOf("function");
	const renderers = session.extensionRunner.resolveToolRenderers("skill", () => undefined);
	await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
	expect(session.extensionRunner.resolveToolRenderers("skill", () => undefined)?.renderCall).toBe(renderers?.renderCall);
	for (const [index, name] of toolNames.entries()) expect(session.getToolDefinition(name)).toBe(definitions[index]);
	await session.reload();
	expect(session.getToolDefinition("skill")?.renderCall).toBeUndefined();
	expect(session.extensionRunner.resolveToolRenderers("skill", () => undefined)?.renderCall).toBeTypeOf("function");
});

it("Bash 保留原生结果渲染，未接管的工具继续使用后续呈现器", async () => {
	const session = await start();
	await session.bindExtensions({ mode: "tui", onError: ({ error }) => { throw new Error(error); } });
	const nativeBash: ToolRenderers = { renderResult: () => new Text("native output", 0, 0) };
	const bash = session.extensionRunner.resolveToolRenderers("bash", () => nativeBash);
	expect(bash?.renderCall).toBeTypeOf("function");
	expect(bash?.renderCall).not.toBe(nativeBash.renderCall);
	expect(bash?.renderResult).toBe(nativeBash.renderResult);
	expect(session.extensionRunner.resolveToolRenderers("external", () => nativeBash)).toBe(nativeBash);
	expect(session.extensionRunner.resolveToolRenderers("external", () => undefined)).toBeUndefined();
});

it.each<ExtensionContext["mode"]>(["print", "rpc"])("%s 模式不装配工具或命令卡片的 TUI 呈现器", async (mode) => {
	const session = await start();
	await session.bindExtensions({ mode });
	for (const name of toolNames) {
		expect(session.getToolDefinition(name)?.renderCall).toBeUndefined();
		expect(session.extensionRunner.resolveToolRenderers(name, () => undefined)).toBeUndefined();
	}
	expect(session.extensionRunner.getMessageRenderer(SKILL_CONTEXT_MESSAGE)).toBeUndefined();
	expect(session.extensionRunner.getEntryRenderer(SUBAGENT_COMMAND_ENTRY)).toBeUndefined();
});
