import type { GuiModel, GuiSnapshot } from "../../../src/gui/shared/protocol/state.ts";

export function guiModelFixture(overrides: Partial<GuiModel> = {}): GuiModel {
	return {
		provider: "test", id: "test", name: "Test", contextWindow: 128000,
		thinking: { levels: ["off"], resolved: { off: "off", minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" } },
		...overrides,
	};
}

export function guiSnapshot(): GuiSnapshot {
	return {
		cwd: "/fixture", leafId: null, sessionId: "fixture", sessionFile: null, name: "测试会话",
		canSubmit: true, canChangeSession: true, running: false, commandRunning: false,
		liveTools: [], streaming: false, retrying: false, compacting: false,
		contextEntryIds: [], history: [], entries: [], streamingMessage: null,
		model: null, codexSpeed: null, routedModel: null, models: [], scopedModels: [], modelScopeChanged: false, modelServicesRevision: 0,
		defaultModel: { provider: null, id: null, thinking: null },
		thinking: "off", thinkingLevels: ["off", "high"], context: null,
		stats: { sessionId: "fixture", sessionFile: undefined, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0,
			totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
		queue: { steering: [], followUp: [] },
		settings: { compaction: false, retry: false, steering: "all", followUp: "all", autoResize: true, blockImages: false },
		commands: [], tools: [], modelTools: [], toolDefaultsChanged: false, toolPreset: null, providers: [], bashCommand: null, bashOutput: "",
	};
}
