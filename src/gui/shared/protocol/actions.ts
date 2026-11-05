import { arr, bool, int, lit, nul, oneOf, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { CODEX_SPEEDS } from "../../../harness/codex-speed/state.ts";
import type { UsageResetOutcome } from "../../../harness/usage/types.ts";
import { moduleConfigId, object, short, text } from "./schema.ts";
import { TOOL_PRESETS } from "../../../harness/tool-defaults/types.ts";
import { queueModes } from "./state.ts";

const image = object({
	data: text,
	mimeType: oneOf(["image/png", "image/jpeg", "image/webp", "image/gif"]),
	imageCount: opt(int({ minimum: 1 })),
});

/** 跨进程操作参数，目标会话由请求外层明确指定。 */
export const actionSchema = union([
	object({
		action: lit("prompt"),
		text,
		images: arr(image, { maxItems: 8 }),
		behavior: oneOf(["steer", "followUp"]),
	}),
	object({ action: lit("abort") }),
	object({ action: lit("new") }),
	object({ action: lit("reload") }),
	object({ action: lit("sessions") }),
	object({ action: lit("clearQueue") }),
	object({ action: lit("persistTools") }),
	object({ action: lit("persistModels") }),
	object({ action: lit("persistDefaultModel") }),
	object({ action: lit("cancelLogin") }),
	object({
		action: lit("view"),
		view: lit("usage"),
		refresh: opt(bool()),
	}),
	object({ action: lit("view"), view: lit("system") }),
	object({
		action: lit("consumeCodexCredit"),
		creditId: str({ minLength: 1, maxLength: 4096 }),
		requestId: str({ minLength: 1, maxLength: 128 }),
	}),
	object({ action: lit("cancelSessionSearch"), id: short }),
	object({ action: lit("workspace"), path: short }),
	object({ action: lit("removeWorkspace"), path: short }),
	object({ action: lit("openSession"), path: short }),
	object({ action: lit("openSession"), id: short }),
	object({ action: lit("observe"), visible: bool() }),
	object({ action: lit("renameSession"), path: short, name: short }),
	object({ action: lit("autoTitleSession"), path: short }),
	object({ action: lit("deleteSession"), path: short }),
	object({ action: lit("fork"), entryId: short }),
	object({ action: lit("navigate"), entryId: short, summarize: bool() }),
	object({ action: lit("label"), entryId: short, label: short }),
	object({ action: lit("rename"), name: short }),
	object({ action: lit("import"), content: text }),
	object({ action: lit("export"), format: oneOf(["jsonl", "html"]) }),
	object({ action: lit("model"), provider: short, id: short }),
	object({ action: lit("codexSpeed"), speed: oneOf(CODEX_SPEEDS) }),
	object({
		action: lit("thinking"),
		level: ModelThinkingLevelSchema,
	}),
	object({ action: lit("scopeModels"), models: arr(short, { maxItems: 1000, uniqueItems: true }) }),
	object({
		action: lit("settings"),
		compaction: bool(),
		retry: bool(),
		steering: oneOf(queueModes),
		followUp: oneOf(queueModes),
		autoResize: bool(),
		blockImages: bool(),
	}),
	object({ action: lit("compact"), instructions: short }),
	object({
		action: lit("login"),
		provider: short,
		type: oneOf(["api_key", "oauth"]),
	}),
	object({ action: lit("logout"), provider: short }),
	object({ action: lit("tool"), name: short, enabled: bool() }),
	object({ action: lit("toolPreset"), preset: oneOf(TOOL_PRESETS) }),
	object({ action: lit("mcpServers"), names: arr(short, { minItems: 1, maxItems: 1000, uniqueItems: true }), enabled: bool() }),
	object({ action: lit("dialog"), id: short, value: union([text, nul()]) }),
	object({ action: lit("clearNotices"), ids: arr(short, { maxItems: 100, uniqueItems: true }) }),
	object({ action: lit("draft"), text }),
	object({ action: lit("removeStorage"), ids: arr(short, { minItems: 1, maxItems: 1000, uniqueItems: true }) }),
	object({ action: lit("saveMcpConfig"), original: text, content: text }),
	object({ action: lit("saveModelServices"), original: text, content: text }),
	object({ action: lit("saveModuleConfig"), id: moduleConfigId, original: text, content: text }),
	object({ action: lit("saveGuiConfig"), original: text, content: text }),
	object({ action: lit("startupChangelog"), shown: bool() }),
	object({ action: lit("saveConfig"), file: lit("settings.json"), original: text, content: text }),
]);
export type GuiAction = Static<typeof actionSchema>;
export type ConfigAction = Extract<GuiAction, { action: "saveGuiConfig" | "saveMcpConfig" | "saveModelServices" | "saveModuleConfig" | "saveConfig" | "settings" }>;
export type GlobalAction = Extract<GuiAction, { action:
	| "observe" | "cancelSessionSearch" | "removeStorage" | "saveMcpConfig" | "saveModelServices" | "saveModuleConfig"
	| "saveGuiConfig" | "startupChangelog" | "sessions" | "openSession" | "import" | "deleteSession" | "removeWorkspace" | "renameSession" | "autoTitleSession"
}>;
export type WorkspaceAction = Extract<GuiAction, { action: "workspace" }>;
export type SessionNavigationAction = Extract<GuiAction, { action: "new" | "fork" }>;
export type SessionControlAction = Extract<GuiAction, { action: "dialog" | "abort" | "cancelLogin" }>;
export type SessionAction = Exclude<GuiAction, GlobalAction | WorkspaceAction | SessionNavigationAction>;
export type SessionMutation = Exclude<SessionAction, SessionControlAction | { action:
	| "clearNotices" | "draft" | "view" | "consumeCodexCredit" | "prompt" | "clearQueue" | "export" | "login" | "logout" | "compact"
}>;
export interface GuiUsageResetResult {
	outcome: UsageResetOutcome;
	refreshed: boolean;
}
export type GuiActionResult<A extends GuiAction = GuiAction> = A extends { action: "consumeCodexCredit" } ? GuiUsageResetResult : void;
