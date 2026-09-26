import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

interface Timing {
	run: string;
	phase: string;
	at: number;
	action?: string;
	requestId?: string;
	sessionId?: string;
	deliveryId?: number;
	generation?: number;
	submittedAt?: number;
	backendSentAt?: number;
	appliedAt?: number;
}

test.use({ mode: "desktop" });
let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { agentDir } }, info) => {
	test.skip(info.project.name !== "desktop", "仅验证桌面请求链路");
	model = await startModelServer(() => ({ text: "PRIVATE_RESPONSE_MARKER" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "timing-test", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "timing-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "PRIVATE_API_KEY",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await writeFile(path.join(agentDir, "extensions", "slow-input.ts"), `export default function(pi) { pi.on("input", async () => { await new Promise(resolve => setTimeout(resolve, 300)); }); }`);
});
test.afterEach(async () => { await model?.close(); });

test("首次发送的准备延迟可从桥接到界面的时间线定位，日志不含正文", async ({ gui: { app, page } }) => {
	const file = await app.evaluate(({ app }) => `${app.getPath("logs")}/gui-timing.jsonl`);
	const records = async (): Promise<Timing[]> => {
		const values: Timing[] = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		return values.filter((item) => item.run.startsWith(`${app.process().pid}-`));
	};
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("PRIVATE_INPUT_MARKER");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message.user")).toContainText("PRIVATE_INPUT_MARKER");
	await expect(page.locator(".reply-answer")).toContainText("PRIVATE_RESPONSE_MARKER");
	await expect.poll(async () => {
		const values = await records();
		const request = values.find((item) => item.action === "prompt");
		const user = values.find((item) => item.phase === "user_snapshot" && item.sessionId === request?.sessionId);
		return values.some((item) => item.phase === "request_settled" && item.requestId === request?.requestId)
			&& values.some((item) => item.phase === "renderer_applied" && item.generation === user?.generation && item.deliveryId === user?.deliveryId);
	}).toBe(true);
	const values = await records();
	const submitted = values.find((item) => item.action === "prompt");
	const backend = values.find((item) => item.phase === "backend_received" && item.requestId === submitted?.requestId);
	const available = values.find((item) => item.phase === "user_available" && item.sessionId === submitted?.sessionId);
	const user = values.find((item) => item.phase === "user_snapshot" && item.sessionId === submitted?.sessionId);
	const received = values.find((item) => item.phase === "renderer_received" && item.generation === user?.generation && item.deliveryId === user?.deliveryId);
	const applied = values.find((item) => item.phase === "renderer_applied" && item.generation === user?.generation && item.deliveryId === user?.deliveryId);
	if (!submitted || !backend || !available || !user || user.backendSentAt === undefined || !received || !applied) throw new Error(`发送时间线不完整: ${JSON.stringify(values)}`);
	expect(submitted.submittedAt).toBeLessThanOrEqual(submitted.at);
	expect(backend.at).toBeGreaterThanOrEqual(submitted.at);
	expect(available.at).toBeGreaterThanOrEqual(backend.at + 250);
	expect(user.backendSentAt).toBeGreaterThanOrEqual(available.at);
	expect(user.at).toBeGreaterThanOrEqual(user.backendSentAt);
	expect(received.at).toBeGreaterThanOrEqual(user.at);
	expect(applied.appliedAt).toBeGreaterThanOrEqual(received.at);
	expect(await readFile(file, "utf8")).not.toContain("PRIVATE_");
});
