import { parseMcpConfig, type McpConfig } from "../../mcp-validation.ts";
import { createMcpDraft, mcpDraftSerializable, writeMcpDraft, type McpDraft } from "./mcp-draft.ts";

export type McpEditor =
	| { mode: "source"; content: string }
	| { mode: "form"; draft: McpDraft; source: string; baseline: string };

export function readMcpEditor(content: string): McpEditor {
	let value: McpConfig;
	try {
		value = parseMcpConfig(content === "" ? "{}" : content);
	} catch {
		// 损坏配置保留原文，交给 JSON 编辑器修复。
		return { mode: "source", content };
	}
	const draft = createMcpDraft(value);
	return { mode: "form", draft, source: content, baseline: writeMcpDraft(draft) };
}

export function mcpEditorContent(editor: McpEditor): string | undefined {
	if (editor.mode === "source") return editor.content;
	if (!mcpDraftSerializable(editor.draft)) return undefined;
	// 比较实际配置，不包含行 ID 等界面状态。没有修改时保留原文格式。
	const content = writeMcpDraft(editor.draft);
	return content === editor.baseline ? editor.source : content;
}
