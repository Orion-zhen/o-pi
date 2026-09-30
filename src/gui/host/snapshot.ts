import { type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { toolSelectionItems } from "../../harness/tool-defaults/controller.ts";
import { codemodeHiddenDeclarations } from "../../harness/codemode/loadout.ts";
import type { GuiSnapshot } from "../contract.ts";
import { guiModel } from "./runtime.ts";
import { builtinCommands } from "./commands.ts";
import type { GuiHistory } from "./history.ts";
import type { GuiPayloads } from "./payloads.ts";

type PresentationState = Pick<
	GuiSnapshot,
	"canSubmit" | "canChangeSession" | "commandRunning" | "messageDurations" | "liveTools" | "history" | "bashOutput"
>;

/** 从 SDK 当前状态投影界面快照，不保存另一份会话。 */
export function collectGuiSnapshot(runtime: AgentSessionRuntime, presentation: PresentationState, history: GuiHistory, payloads: GuiPayloads): GuiSnapshot {
	const { session, services, cwd } = runtime;
	const routed = session.routedModel;
	const allTools = session.getAllTools();
	const activeTools = session.getActiveToolNames();
	const callableTools = new Set(session.getCallableToolNames());
	const hidden = new Set(activeTools.includes("codemode") ? codemodeHiddenDeclarations(allTools) : []);
	const commands = new Map<string, { name: string; description: string }>();
	for (const command of [
		...session.extensionRunner
			.getRegisteredCommands()
			.map(({ name, description }) => ({ name, description: description ?? "" })),
		...builtinCommands,
		...session.promptTemplates.map(({ name, description }) => ({ name, description })),
		...services.resourceLoader
			.getSkills()
			.skills.map(({ name, description }) => ({ name: `skill:${name}`, description })),
	])
		if (!commands.has(command.name)) commands.set(command.name, command);
	return {
		...presentation,
		cwd,
		leafId: session.sessionManager.getLeafId(),
		sessionId: session.sessionId,
		sessionFile: session.sessionFile ?? null,
		name: session.sessionName ?? "未命名会话",
		streaming: session.isStreaming,
		retrying: session.isRetrying,
		running: !session.isIdle || session.isBashRunning || presentation.commandRunning,
		// context_edit 只改变模型上下文，聊天区继续展示原始历史。
		...history.project(session.sessionManager),
		streamingMessage: payloads.stream(session.state.streamingMessage ?? null),
		model: session.model ? guiModel(session.model) : null,
		routedModel: routed ? { model: guiModel(routed.model), ...(routed.thinkingLevel === undefined ? {} : { thinkingLevel: routed.thinkingLevel }) } : null,
		models: services.modelRuntime.getAvailableSnapshot().map(guiModel),
		scopedModels: session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
		thinking: session.thinkingLevel,
		thinkingLevels: session.getAvailableThinkingLevels(),
		context: session.getContextUsage() ?? null,
		stats: session.getSessionStats(),
		// SDK 原地追加队列，快照必须持有独立数组供增量比较。
		queue: { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] },
		settings: {
			compaction: session.autoCompactionEnabled,
			retry: session.autoRetryEnabled,
			steering: session.steeringMode,
			followUp: session.followUpMode,
			autoResize: services.settingsManager.getImageAutoResize(),
			blockImages: services.settingsManager.getBlockImages(),
		},
		commands: [...commands.values()],
		tools: toolSelectionItems(allTools, activeTools).map((tool) => ({ ...tool, callable: callableTools.has(tool.name) })),
		modelTools: activeTools.filter((name) => !hidden.has(name)),
		providers: services.modelRuntime
			.getProviders()
			.map((provider) => ({
				id: provider.id,
				name: provider.name,
				oauth: provider.auth.oauth !== undefined,
				authenticated: services.modelRuntime.hasConfiguredAuth(provider.id),
			})),
	};
}
