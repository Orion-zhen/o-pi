import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import type { GuiClient } from "../../src/gui/host/client.ts";
import { startModelServer } from "../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-gui-repro-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_GUI_CONFIG", "PI_OFFLINE");
let host: GuiClient;
let server: Awaited<ReturnType<typeof startModelServer>>;
let cwd: string;
const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = await mkdtemp(path.join(process.cwd(), ".gui-repro-"));
	const agentDir = path.join(temp.path, ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_GUI_CONFIG;
	process.env.PI_OFFLINE = "1";
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	server = await startModelServer(() => ({ text: "ok" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "gui-fixture", defaultModel: "test",
		defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "gui-fixture": {
		baseUrl: server.url, api: "openai-completions", apiKey: "k",
		models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const skillDir = path.join(agentDir, "skills", "oops");
	await mkdir(skillDir, { recursive: true });
	await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: oops\ndescription: 误加载技能\n---\n正文\n");
	host = new GuiHost().createClient();
	await host.host.start(cwd);
});
afterEach(async () => {
	await host?.host.dispose();
	await server?.close();
	await rmDir(cwd);
});
async function rmDir(dir: string) {
	const { rm } = await import("node:fs/promises");
	await rm(dir, { recursive: true, force: true });
}

describe("待发送会话误加载技能", () => {
	it("加载技能后点击新建应得到干净会话", async () => {
		const pending = host.selected;
		expect(pending?.pending).toBe(true);
		await host.dispatch(prompt("/skill:oops"));
		// 技能已被披露到当前 pending 会话
		expect(host.snapshot().sessionFile).toBeTruthy();
		// 用户点击新建，期望刷新掉误加载
		await host.dispatch({ action: "new" });
		expect(host.selected).not.toBe(pending);
		expect(host.selected?.pending).toBe(true);
		const branch = host.selected ? [...host.host.sessions.values()].find((s) => s === host.selected) : undefined;
		void branch;
	});
});
