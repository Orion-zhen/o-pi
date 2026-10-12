import type { GuiSnapshot } from "../../src/gui/contract.ts";

export function guiSnapshot(): GuiSnapshot {
	return {
		cwd: "/fixture", leafId: null, sessionId: "fixture", sessionFile: null, name: "测试会话",
		canSubmit: true, canChangeSession: true, running: false, commandRunning: false,
		liveTools: [], streaming: false, retrying: false, compacting: false,
		contextEntryIds: [], history: [], entries: [], messageDurations: {}, streamingMessage: null,
		model: null, routedModel: null, models: [], scopedModels: [], modelScopeChanged: false,
		defaultModel: { provider: null, id: null, thinking: null },
		thinking: "off", thinkingLevels: ["off", "high"], context: null,
		stats: { sessionId: "fixture", sessionFile: undefined, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0,
			totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
		queue: { steering: [], followUp: [] },
		settings: { compaction: false, retry: false, steering: "all", followUp: "all", autoResize: true, blockImages: false },
		commands: [], tools: [], modelTools: [], toolDefaultsChanged: false, providers: [], bashOutput: "",
	};
}
