import path from "node:path";
import type { Page } from "@playwright/test";
import type { GuiEvent, GuiQuery, GuiSnapshot } from "../../src/gui/contract.ts";
import type { GuiEntry, GuiMessage } from "../../src/gui/messages.ts";
import { GuiChannel } from "../../src/gui/host/channel.ts";
import { readGuiDefaults } from "../../src/gui/host/preferences.ts";
import { assistant } from "./transcript-fixtures.ts";

export function liveSnapshot(): GuiSnapshot {
	const entries: GuiEntry[] = [];
	const append = (message: GuiMessage) => entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
		type: "message", timestamp: new Date(message.timestamp).toISOString(), messages: [message], label: undefined });
	append({ role: "user", content: "检查项目并持续报告进度", timestamp: 1 });
	for (let index = 0; index < 220; index++) {
		const file = `module-${index}.ts`;
		const code = Array.from({ length: 60 }, (_, line) => `export const value${line} = { index: ${index}, text: "检查状态 ${line}" };`).join("\n");
		append({ ...assistant([
			...(index % 20 === 0 ? [{ type: "text" as const, text: `检查第 ${index / 20 + 1} 组文件。` }] : []),
			{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: file } },
		]), timestamp: index * 2 + 2 });
		append({ role: "toolResult", toolCallId: `read-${index}`, toolName: "read", isError: false, timestamp: index * 2 + 3,
			output: { kind: "inline", value: { content: [{ type: "text", text: code }], details: {
				path: file, total_lines: 60, segments: [{ content: code, start_line: 1, end_line: 60 }],
			} } } });
	}
	return {
		cwd: "/fixture", leafId: entries.at(-1)?.id ?? null, sessionId: "live-perf", sessionFile: null, name: "长轮次交互",
		canSubmit: true, canChangeSession: false, running: true, commandRunning: false, liveTools: [], streaming: true, retrying: false,
		contextEntryIds: entries.map((entry) => entry.id), history: [], entries, messageDurations: {},
		streamingMessage: { ...assistant([{ type: "thinking", thinking: "继续检查" }], "pending"), timestamp: 1000 },
		model: null, routedModel: null, models: [], scopedModels: [], defaultModel: { provider: null, id: null, thinking: null },
		thinking: "high", thinkingLevels: ["off", "high"], context: null,
		stats: { sessionId: "live-perf", sessionFile: undefined, userMessages: 1, assistantMessages: 220, toolCalls: 220, toolResults: 220,
			totalMessages: 441, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
		queue: { steering: [], followUp: [] }, settings: { compaction: false, retry: false, steering: "all", followUp: "all", autoResize: true, blockImages: false },
		commands: [], tools: [], modelTools: [], providers: [], bashOutput: "",
	};
}

/** 回放协议事件，保留正式 GUI、增量合并和浏览器渲染，不执行模型或工具。 */
export async function replayTranscript(page: Page, snapshot: GuiSnapshot) {
	const origin = "http://127.0.0.1:43177";
	const defaults = readGuiDefaults();
	await page.route(`${origin}/**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/action") { await route.fulfill({ json: null }); return; }
		if (url.pathname === "/api/query") {
			const { value } = route.request().postDataJSON() as { value: GuiQuery };
			switch (value.query) {
				case "guiConfig": await route.fulfill({ json: { state: "ready", path: "/fixture/gui.jsonc", content: "", defaults, value: defaults } }); return;
				case "availableVersion": case "startupChangelog": case "workspaceGit": await route.fulfill({ json: null }); return;
				case "workspaceFiles": case "complete": await route.fulfill({ json: [] }); return;
				default: throw new Error(`回放未提供查询: ${value.query}`);
			}
		}
		await route.fulfill({ path: path.resolve("dist/gui", url.pathname === "/" ? "index.html" : url.pathname.slice(1)) });
	});
	const connected = Promise.withResolvers<GuiChannel>();
	await page.routeWebSocket(`${origin.replace("http:", "ws:")}/api/events*`, (socket) => {
		const channel = new GuiChannel((delivery) => socket.send(JSON.stringify(delivery)));
		socket.onMessage((message) => { const { ack } = JSON.parse(String(message)) as { ack: number }; channel.acknowledge(ack); });
		socket.onClose(() => channel.close());
		for (const event of [
			{ type: "client", id: "fixture" }, { type: "workspaceRoot", path: snapshot.cwd },
			{ type: "selected", session: { id: snapshot.sessionId, cwd: snapshot.cwd, path: null } },
			{ type: "snapshot", value: snapshot }, { type: "sessions", value: [] },
		] satisfies GuiEvent[]) channel.accept(event);
		connected.resolve(channel);
	});
	await page.goto(origin);
	return connected.promise;
}
