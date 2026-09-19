import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
	resolveModelScopeWithDiagnostics,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createGuiExtensions, type GuiExtensionBindings } from "./extensions.ts";

EventEmitter.defaultMaxListeners = 20;

export async function createGuiRuntime(
	cwd: string,
	bindings: GuiExtensionBindings,
	sessionManager?: SessionManager,
) {
	const { dialogs } = bindings;
	cwd = path.resolve(cwd);
	if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不是文件夹。");
	const agentDir = getAgentDir();
	const trust = new ProjectTrustStore(agentDir);
	const decisions = new Map<string, boolean>();
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
					if (!hasTrustRequiringProjectResources(cwd)) return true;
					// 此阶段 SDK 只加载用户级信任处理器，项目扩展仍未执行。
					for (const extension of extensionsResult.extensions) {
						for (const handler of extension.handlers.get("project_trust") ?? []) {
							try {
								const result: unknown = await handler(
									{ type: "project_trust", cwd },
									{ cwd, mode: "print", hasUI: true, ui: dialogs.context() },
								);
								if (typeof result !== "object" || result === null || !("trusted" in result))
									throw new Error("无效 project_trust 返回值");
								if (result.trusted === "undecided") continue;
								if (result.trusted !== "yes" && result.trusted !== "no") throw new Error("无效 project_trust 决策");
								const trusted = result.trusted === "yes";
								if ("remember" in result && result.remember === true) trust.set(cwd, trusted);
								decisions.set(cwd, trusted);
								return trusted;
							} catch (error) {
								dialogs.notify(`${extension.path}: ${error instanceof Error ? error.message : String(error)}`, "error");
							}
						}
					}
					const saved = trust.get(cwd);
					if (saved !== null) return saved;
					const defaultTrust = settingsManager.getDefaultProjectTrust();
					if (defaultTrust !== "ask") return defaultTrust === "always";
					const answer = await dialogs.ask(
						"select",
						"信任项目",
						`${cwd}\n允许加载项目配置、技能和执行项目扩展。仅信任你了解的项目。`,
						["仅本次信任", "始终信任", "不信任"],
					);
					const trusted = answer === "仅本次信任" || answer === "始终信任";
					if (answer === "始终信任") trust.set(cwd, true);
					decisions.set(cwd, trusted);
					return trusted;
				},
			},
		});
		const scope = await resolveModelScopeWithDiagnostics(
			settingsManager.getEnabledModels() ?? [],
			services.modelRuntime,
		);
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			...(sessionStartEvent ? { sessionStartEvent } : {}),
			scopedModels: scope.scopedModels,
		});
		for (const diagnostic of services.diagnostics)
			dialogs.notify(diagnostic.message, diagnostic.type === "error" ? "error" : "warning");
		for (const error of services.resourceLoader.getExtensions().errors)
			dialogs.notify(`${error.path}: ${error.error}`, "error");
		return { ...result, services, diagnostics: services.diagnostics };
	};
	return createAgentSessionRuntime(factory, {
		cwd,
		agentDir,
		sessionManager: sessionManager ?? SessionManager.create(cwd),
	});
}

export function guiModel(model: NonNullable<AgentSession["model"]>) {
	return { id: model.id, provider: model.provider, name: model.name, contextWindow: model.contextWindow };
}
