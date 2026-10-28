import { Type, type Static } from "typebox";
import { CODEX_SPEEDS } from "../../../harness/codex-speed/state.ts";
import type { UsageResetOutcome } from "../../../harness/usage/types.ts";
import { moduleConfigId, object, short, text } from "./schema.ts";
import { TOOL_PRESETS } from "../../../harness/tool-defaults/types.ts";
import { queueModes } from "./state.ts";

const image = object({
	data: text,
	mimeType: Type.Union([
		Type.Literal("image/png"),
		Type.Literal("image/jpeg"),
		Type.Literal("image/webp"),
		Type.Literal("image/gif"),
	]),
});

/** 跨进程操作参数，目标会话由请求外层明确指定。 */
export const actionSchema = Type.Union([
	object({
		action: Type.Literal("prompt"),
		text,
		images: Type.Array(image, { maxItems: 8 }),
		behavior: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
	}),
	object({
		action: Type.Union([
			Type.Literal("abort"),
			Type.Literal("new"),
			Type.Literal("reload"),
			Type.Literal("sessions"),
			Type.Literal("clearQueue"),
			Type.Literal("persistTools"),
			Type.Literal("persistModels"),
			Type.Literal("persistDefaultModel"),
			Type.Literal("cancelLogin"),
		]),
	}),
	object({
		action: Type.Literal("view"),
		view: Type.Literal("usage"),
		refresh: Type.Optional(Type.Boolean()),
	}),
	object({ action: Type.Literal("view"), view: Type.Literal("system") }),
	object({
		action: Type.Literal("consumeCodexCredit"),
		creditId: Type.String({ minLength: 1, maxLength: 4096 }),
		requestId: Type.String({ minLength: 1, maxLength: 128 }),
	}),
	object({ action: Type.Literal("cancelSessionSearch"), id: short }),
	object({ action: Type.Literal("workspace"), path: short }),
	object({ action: Type.Literal("removeWorkspace"), path: short }),
	object({ action: Type.Literal("openSession"), path: short }),
	object({ action: Type.Literal("openSession"), id: short }),
	object({ action: Type.Literal("observe"), visible: Type.Boolean() }),
	object({ action: Type.Literal("renameSession"), path: short, name: short }),
	object({ action: Type.Literal("deleteSession"), path: short }),
	object({ action: Type.Literal("fork"), entryId: short }),
	object({ action: Type.Literal("navigate"), entryId: short, summarize: Type.Boolean() }),
	object({ action: Type.Literal("label"), entryId: short, label: short }),
	object({ action: Type.Literal("rename"), name: short }),
	object({ action: Type.Literal("import"), content: text }),
	object({ action: Type.Literal("export"), format: Type.Union([Type.Literal("jsonl"), Type.Literal("html")]) }),
	object({ action: Type.Literal("model"), provider: short, id: short }),
	object({ action: Type.Literal("codexSpeed"), speed: Type.Enum(CODEX_SPEEDS) }),
	object({
		action: Type.Literal("thinking"),
		level: Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	}),
	object({ action: Type.Literal("scopeModels"), models: Type.Array(short, { maxItems: 1000, uniqueItems: true }) }),
	object({
		action: Type.Literal("settings"),
		compaction: Type.Boolean(),
		retry: Type.Boolean(),
		steering: Type.Enum(queueModes),
		followUp: Type.Enum(queueModes),
		autoResize: Type.Boolean(),
		blockImages: Type.Boolean(),
	}),
	object({ action: Type.Literal("compact"), instructions: short }),
	object({
		action: Type.Literal("login"),
		provider: short,
		type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
	}),
	object({ action: Type.Literal("logout"), provider: short }),
	object({ action: Type.Literal("tool"), name: short, enabled: Type.Boolean() }),
	object({ action: Type.Literal("toolPreset"), preset: Type.Enum(TOOL_PRESETS) }),
	object({ action: Type.Literal("mcpServers"), names: Type.Array(short, { minItems: 1, maxItems: 1000, uniqueItems: true }), enabled: Type.Boolean() }),
	object({ action: Type.Literal("dialog"), id: short, value: Type.Union([text, Type.Null()]) }),
	object({ action: Type.Literal("clearNotices"), ids: Type.Array(short, { maxItems: 100, uniqueItems: true }) }),
	object({ action: Type.Literal("draft"), text }),
	object({ action: Type.Literal("removeStorage"), ids: Type.Array(short, { minItems: 1, maxItems: 1000, uniqueItems: true }) }),
	object({ action: Type.Literal("saveMcpConfig"), original: text, content: text }),
	object({ action: Type.Literal("saveModelServices"), original: text, content: text }),
	object({ action: Type.Literal("saveModuleConfig"), id: moduleConfigId, original: text, content: text }),
	object({ action: Type.Literal("saveGuiConfig"), original: text, content: text }),
	object({ action: Type.Literal("startupChangelog"), shown: Type.Boolean() }),
	object({ action: Type.Literal("saveConfig"), file: Type.Literal("settings.json"), original: text, content: text }),
]);
export type GuiAction = Static<typeof actionSchema>;
export interface GuiUsageResetResult {
	outcome: UsageResetOutcome;
	refreshed: boolean;
}
export type GuiActionResult<A extends GuiAction = GuiAction> = A extends { action: "consumeCodexCredit" } ? GuiUsageResetResult : void;
