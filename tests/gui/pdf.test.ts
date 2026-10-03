import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { afterEach, expect, it } from "vitest";
import { GuiHost } from "../../src/gui/host/host.ts";
import { startModelServer } from "../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-gui-pdf-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_GUI_CONFIG", "PI_OFFLINE");
let gui: GuiHost | undefined;
let model: Awaited<ReturnType<typeof startModelServer>> | undefined;
afterEach(async () => {
	try { await gui?.dispose(); }
	finally { await model?.close(); }
});

it("read PDF 经 GUI 宿主将按模型限制缩放的页面图片发送给模型", async () => {
	setTestHome(temp.path);
	const cwd = path.join(temp.path, "workspace");
	const agentDir = path.join(temp.path, ".pi", "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	delete process.env.PI_GUI_CONFIG;
	await mkdir(cwd);
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await copyFile("tests/harness/file-tools/fixtures/read/vector.pdf", path.join(cwd, "document.pdf"));
	model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
		? { text: "PDF 验证完成" }
		: { tool: "read", args: { path: "document.pdf", pages: "1" } });
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "pdf-test", defaultModel: "test",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "pdf-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", name: "test", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
			inputLimits: { images: { resize: { maxWidth: 96, maxHeight: 96 } } },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	gui = new GuiHost();
	const client = gui.createClient();
	await gui.start(cwd);
	await client.dispatch({ action: "prompt", text: "读取 document.pdf", images: [], behavior: "steer" });
	const result = model.requests.findLast((request) => Array.isArray(request.messages));
	expect(result).toBeDefined();
	const payload = JSON.stringify(result?.messages);
	expect(payload).not.toContain("<error>");
	const images = payload.match(/data:image\/png;base64,[^"\\]+/g);
	expect(images).toHaveLength(1);
	if (!images?.[0]) throw new Error("缺少 PDF 页面图片");
	const image = await loadImage(images[0]);
	expect(Math.max(image.width, image.height)).toBe(96);
});
