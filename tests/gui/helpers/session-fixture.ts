import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export async function storeSession({
	cwd,
	agentDir,
	provider,
	name,
	text = "历史问题",
	timestamp = Date.now(),
}: {
	cwd: string;
	agentDir: string;
	provider: string;
	name?: string;
	text?: string;
	timestamp?: number;
}) {
	await mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, path.join(agentDir, "sessions", path.basename(cwd)));
	if (name) manager.appendSessionInfo(name);
	manager.appendMessage({ role: "user", content: text, timestamp });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "历史回复" }],
		api: "openai-completions",
		provider,
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	});
	const file = manager.getSessionFile();
	if (!file) throw new Error("历史会话未持久化");
	return file;
}
