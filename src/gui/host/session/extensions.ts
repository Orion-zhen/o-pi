import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import llamaExtension from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/index.js";
import { createGuiMcpExtension, type GuiMcpTools } from "./mcp-tools.ts";
import { createHarnessExtensions } from "../../../harness/extensions.ts";
import { registerAttention } from "../../../harness/attention.ts";
import { collectContextStats } from "../../../harness/extensions/stats.ts";
import systemPrompt from "../../../harness/extensions/system-prompt.ts";
import usage from "../../../harness/extensions/usage.ts";
import type { UsageService } from "../../../harness/usage/service.ts";
import { createLiveTelemetryReport } from "../../../harness/telemetry-report/live.ts";
import { createSubagentExtension } from "../../../harness/extensions/subagent.ts";
import { createToolsExtension } from "../../../harness/extensions/cmd-slash-tools.ts";
import type { ToolSelectionController } from "../../../harness/tool-defaults/controller.ts";
import type { GuiDialogs } from "./dialogs.ts";
import type { GuiEvent } from "../../contract.ts";
import type { GuiReports } from "../projection/reports.ts";
import { createApprovalGate } from "../../../harness/approval/runtime/gate.ts";
import type { ApprovalStores, SessionApprovalRules } from "../../../harness/approval/rules/store.ts";
import approvalGate from "../../../harness/extensions/approval-gate.ts";
import autoTitle from "../../../harness/extensions/auto-title.ts";
import openAICompatibleProvider from "../../../harness/extensions/openai-compatible-provider.ts";
import type { ModelsConfig } from "../../../harness/openai-compatible-provider/schema.ts";
import { lspManager, registerLspCommands } from "../../../harness/lsp/index.ts";

export interface GuiExtensionBindings {
	dialogs: GuiDialogs;
	approvalStores: ApprovalStores;
	approvalRules: SessionApprovalRules;
	trackBackground(task: Promise<void>, cancel: () => void): Promise<void>;
	emit(event: GuiEvent): void;
	bindTools(controller: ToolSelectionController): void;
	bindMcp(tools: GuiMcpTools): void;
	bindModelServices(config: ModelsConfig | undefined): void;
	toolsChanged(): void;
	commandSignal(): AbortSignal;
	reports: GuiReports;
	usageService: UsageService;
}

export function createGuiExtensions({ dialogs, emit, bindTools, bindMcp, bindModelServices, toolsChanged, commandSignal, reports, usageService, approvalStores, approvalRules, trackBackground }: GuiExtensionBindings): InlineExtension[] {
	const views: InlineExtension[] = [
		{ name: "openai-compatible-provider", factory: (pi) => openAICompatibleProvider(pi, bindModelServices) },
		{ name: "mcp", builtin: true, factory: createGuiMcpExtension({
			bind: bindMcp, changed: toolsChanged,
			openUrl: (url) => emit({ type: "auth", value: { type: "auth_url", url } }),
			showConfig: () => emit({ type: "panel", panel: { kind: "settings", category: "mcp" } }),
		}) },
		{ name: "auto-title", factory: (pi) => autoTitle(pi, trackBackground) },
		{ name: "approval-gate", factory: (pi) => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }, createApprovalGate(approvalStores, approvalRules)) },
		// LSP 由宿主统一释放，回收单个会话不能重置其他会话的服务。
		{ name: "lsp", factory: (pi) => {
			registerLspCommands(pi, lspManager);
			pi.on("session_shutdown", async (event) => { if (event.reason === "reload") await lspManager.reload(); });
		} },
		{
			name: "stats",
			factory: (pi) => {
				reports.bindStats((ctx) => collectContextStats(ctx, pi));
				pi.registerCommand("stats", {
					description: "Show current session stats.",
					handler: async () => emit({ type: "sessionTab", tab: "stats" }),
				});
			},
		},
		{
			name: "system-prompt",
			factory: (pi) => systemPrompt(pi, {
				mode: "gui", show: async (_ctx, text) => emit({ type: "panel", panel: { kind: "system", text } }),
			}),
		},
		{
			name: "usage",
			factory: (pi) => usage(pi, {
				mode: "gui", show: async (_ctx, value) => emit({ type: "panel", panel: { kind: "usage", value } }),
			}, usageService),
		},
		{
			name: "cmd-slash-tools",
			factory: createToolsExtension({
				gui: { mode: "gui", show: () => emit({ type: "panel", panel: { kind: "tools" } }) },
				bindController: bindTools,
			}),
		},
	];
	const extensions = createHarnessExtensions({
		subagent: createSubagentExtension(undefined, {
			signal: commandSignal,
			onProgress: ({ result }) => emit({ type: "panel", panel: { kind: "subagents", details: result.details } }),
			present: (result) => emit({ type: "panel", panel: { kind: "subagents", details: result.details } }),
		}),
		telemetry(pi, service) {
			pi.registerCommand("telemetry", {
				description: "Show telemetry of current session.",
				handler: async () => emit({ type: "sessionTab", tab: "telemetry" }),
			});
			reports.bindTelemetry(() => createLiveTelemetryReport(service.snapshot()));
		},
	});
	return [
		{ name: "notifications", factory: (pi) => registerAttention(pi, (value) => emit({ type: "notification", value })) },
		{ name: "llama.cpp", builtin: true, factory: llamaExtension },
		...extensions.map((extension) => views.find((view) => view.name === extension.name) ?? extension),
	];
}
