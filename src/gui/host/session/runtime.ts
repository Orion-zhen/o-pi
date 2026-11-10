import { EventEmitter } from "node:events";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	AgentSessionRuntime,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type SessionManager,
	SettingsManager,
	resolveModelScopeWithDiagnostics,
	type AgentSession,
	type SessionStartEvent,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { resolveProjectTrusted } from "./project-trust.ts";
import { createGuiExtensions, type GuiExtensionBindings } from "./extensions.ts";
import type { GuiModelScope } from "./models.ts";
import type { GuiModel } from "../../shared/protocol/state.ts";

EventEmitter.defaultMaxListeners = 20;

export async function createGuiRuntime(
	cwd: string,
	bindings: GuiExtensionBindings & { projectTrust: Map<string, boolean> },
	sessionManager: SessionManager,
	initialEvent: SessionStartEvent,
	cachedScope: string[] | undefined,
	modelScope: GuiModelScope,
) {
	const { dialogs, projectTrust: decisions } = bindings;
	const agentDir = getAgentDir();
	const trust = new ProjectTrustStore(agentDir);
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: createGuiExtensions(bindings) },
			resourceLoaderReloadOptions: {
				resolveProjectTrust: async ({ extensionsResult }) => {
					const cached = decisions.get(cwd);
					if (cached !== undefined) return cached;
					const trusted = await resolveProjectTrusted({
						cwd,
						trustStore: trust,
						defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
						extensionsResult,
						projectTrustContext: { cwd, mode: "print", hasUI: true, ui: dialogs.context() },
						onExtensionError: (message) => dialogs.notify(message, "warning"),
					});
					// 与原生入口一致，只缓存需要信任决策的项目。
					if (hasTrustRequiringProjectResources(cwd)) decisions.set(cwd, trusted);
					return trusted;
				},
			},
		});
		const defaultPatterns = settingsManager.getGlobalSettings().enabledModels ?? [];
		const patterns = cachedScope ?? settingsManager.getEnabledModels() ?? [];
		const defaultScope = await resolveModelScopeWithDiagnostics(defaultPatterns, services.modelRuntime);
		const scope = patterns.length === defaultPatterns.length && patterns.every((pattern, index) => pattern === defaultPatterns[index])
			? defaultScope : await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime);
		modelScope.initialize(scope, defaultScope);
		for (const diagnostic of scope.diagnostics) dialogs.notify(diagnostic.message, "warning");
		const context = sessionManager.buildSessionContext();
		const model = context.messages.length === 0 && context.model
			? services.modelRuntime.getModel(context.model.provider, context.model.modelId)
			: undefined;
		const initialSelection = model ? { model, thinkingLevel: context.thinkingLevel as ThinkingLevel } : {};
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			...initialSelection,
			...(sessionStartEvent ? { sessionStartEvent } : {}),
			scopedModels: scope.scopedModels,
		});
		for (const diagnostic of services.diagnostics)
			dialogs.notify(diagnostic.message, diagnostic.type === "error" ? "error" : "warning");
		for (const error of services.resourceLoader.getExtensions().errors)
			dialogs.notify(`${error.path}: ${error.error}`, "error");
		return { ...result, services, diagnostics: services.diagnostics };
	};
	// GUI 允许打开失效工作区，目录检查留在消息提交边界，不使用 SDK 的启动目录校验。
	const result = await factory({ cwd, agentDir, sessionManager, sessionStartEvent: initialEvent });
	return new AgentSessionRuntime(result.session, result.services, factory, result.diagnostics, result.modelFallbackMessage);
}

export function guiModel(model: NonNullable<AgentSession["model"]>): GuiModel {
	return {
		id: model.id, provider: model.provider, name: model.name, contextWindow: model.contextWindow,
		thinking: {
			levels: getSupportedThinkingLevels(model),
			resolved: Object.fromEntries(MODEL_THINKING_LEVELS.map((level) => [level, clampThinkingLevel(model, level)])),
		},
	};
}
