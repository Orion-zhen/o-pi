import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { toolAvailableOnCurrentPlatform } from "../../harness/tool-defaults/controller.ts";
import type { GuiSnapshot } from "../contract.ts";
import { guiModel } from "./runtime.ts";
import { builtinCommands } from "./commands.ts";

type PresentationState = Pick<
	GuiSnapshot,
	"canSubmit" | "canChangeSession" | "commandRunning" | "messageDurations" | "liveTools" | "history" | "status"
>;

/** 从 SDK 当前状态投影界面快照，不保存另一份会话。 */
export function collectGuiSnapshot(runtime: AgentSessionRuntime, presentation: PresentationState): GuiSnapshot {
	const { session, services, cwd } = runtime;
	const active = new Set(session.getActiveToolNames());
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
		messages: session.messages,
		streamingMessage: session.state.streamingMessage ?? null,
		entries: session.sessionManager.getEntries(),
		model: session.model ? guiModel(session.model) : null,
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
		tools: session.getAllTools().map((tool) => {
			const { name, description } = tool;
			return toolAvailableOnCurrentPlatform(tool)
				? { name, description, available: true, enabled: active.has(name) }
				: { name, description, available: false, enabled: false };
		}),
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
