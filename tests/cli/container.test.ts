import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { expect, it } from "vitest";
import { useTempDir } from "../helpers/lifecycle.js";
import { startModelServer, type ModelResponse } from "./model-server.js";

const temp = useTempDir("opi-container-");
const image = process.env.OPI_CONTAINER_IMAGE;

it.skipIf(process.platform !== "linux" || image === undefined)("无仓库、Node、Bun 的容器中运行完整工具回路", async () => {
	const agent = path.join(temp.path, ".pi/agent");
	await mkdir(path.join(agent, "agents"), { recursive: true });
	await mkdir(path.join(agent, "configs"));
	await copyFile(path.resolve("dist/opi"), path.join(temp.path, "opi"));
	await copyFile(path.resolve("tests/file-tools/fixtures/read/two-page.pdf"), path.join(temp.path, "sample.pdf"));
	await writeFile(path.join(temp.path, "sample.ts"), "export const value = 1;\n");
	await writeFile(path.join(temp.path, "large.ts"), "export const valueInWorker = 3;\n" + "// worker input\n".repeat(20_000));
	const canvas = createCanvas(3000, 2000);
	canvas.getContext("2d").fillRect(0, 0, 3000, 2000);
	await writeFile(path.join(temp.path, "sample.png"), canvas.toBuffer("image/png"));
	await writeFile(path.join(agent, "agents/scout.md"), "---\nname: scout\ndescription: Read source\ntools: read\n---\nRead sample.ts.\n");
	await writeFile(path.join(agent, "configs/discord-presence.jsonc"), '{"enabled":false}');
	const actions: ModelResponse[] = [
		{ tool: "ls", args: { path: "." } },
		{ tool: "read", args: { path: "sample.pdf", pages: "1" } },
		{ tool: "read", args: { path: "sample.png" } },
		{ tool: "grep", args: { query: "value", path: ["sample.ts", "large.ts"] } },
		{ tool: "subagent", args: { tasks: [{ agent: "scout", task: "Read sample.ts" }] } },
		{ tool: "bash", args: { command: "printf standalone-ok" } },
		{ tool: "webfetch", args: { url: "http://127.0.0.1/" } },
	];
	const server = await startModelServer((request) => {
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (!request.tools?.some((tool) => tool.function.name === "subagent")) {
			return count === 0 ? { tool: "read", args: { path: "sample.ts" } } : { text: JSON.stringify(request.messages) };
		}
		return actions[count] ?? { text: "completed" };
	});
	try {
		await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off", retry: { enabled: false }, compaction: { enabled: false } }));
		await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
			baseUrl: server.url, apiKey: "fixture", api: "openai-completions",
			models: [{ id: "test", name: "Fixture", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		} } }));
		const { stdout, stderr } = await promisify(execFile)(process.env.CONTAINER_ENGINE ?? "podman", [
			"run", "--rm", "--network=host", "--userns=keep-id", "--entrypoint", "/bin/sh",
			"-v", `${temp.path}:/test:Z`, "-w", "/test", "-e", "HOME=/test", "-e", "PI_CODING_AGENT_DIR=/test/.pi/agent",
			"-e", "PI_OFFLINE=1", "-e", "PI_SKIP_VERSION_CHECK=1", image ?? "",
			"-c", 'test -z "$(command -v node)" && test -z "$(command -v bun)" && exec ./opi --offline --approve --no-session --mode json "Run the fixture"',
		], { timeout: 60_000, maxBuffer: 12 * 1024 * 1024 });
		expect(stderr).toBe("");
		const results = stdout.trim().split("\n").flatMap((line) => {
			const event = JSON.parse(line) as { type: string; message?: { role: string; toolName: string; isError: boolean; content: unknown } };
			return event.type === "message_end" && event.message?.role === "toolResult" ? [event.message] : [];
		});
		expect(results.map((result) => result.toolName)).toEqual(actions.map((action) => "tool" in action ? action.tool : ""));
		expect(results.slice(0, -1).every((result) => !result.isError), JSON.stringify(results)).toBe(true);
		expect(results.at(-1)?.isError).toBe(true);
		expect(JSON.stringify(results.at(-1))).toMatch(/BLOCKED_ADDRESS|private|Private|approval|Approval/);
		expect(JSON.stringify(results[4])).toContain("value = 1");
	} finally {
		await server.close();
	}
}, 75_000);
