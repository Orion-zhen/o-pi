import { parseMcpConfig, type McpConfig } from "../../mcp-validation.ts";
import { createMcpDraft, mcpDraftSerializable, mcpMapFields, writeMcpDraft, type McpDraft } from "./mcp-draft.ts";

export type McpEditor =
	| { mode: "source"; content: string }
	| { mode: "form"; draft: McpDraft; baselineDraft: McpDraft; source: string; baseline: string };

export function readMcpEditor(content: string): McpEditor {
	let value: McpConfig;
	try {
		value = parseMcpConfig(content === "" ? "{}" : content);
	} catch {
		// 损坏配置保留原文，交给 JSON 编辑器修复。
		return { mode: "source", content };
	}
	const draft = createMcpDraft(value);
	return { mode: "form", draft, baselineDraft: draft, source: content, baseline: writeMcpDraft(draft) };
}

export function discardMcpEditor(content: string, editor: McpEditor): McpEditor {
	if (editor.mode === "source") return { mode: "source", content };
	if (content === editor.source) return { ...editor, draft: editor.baselineDraft };
	const restored = readMcpEditor(content);
	if (restored.mode === "source") return restored;
	const previous = new Map(editor.baselineDraft.servers.map((server) => [server.name, server]));
	const draft: McpDraft = { ...restored.draft, servers: restored.draft.servers.map((server) => {
		const original = previous.get(server.name);
		if (!original) return server;
		const maps = { ...server.maps };
		for (const field of mcpMapFields) {
			const rows = maps[field];
			if (rows) maps[field] = rows.map((row) => ({ ...row, id: original.maps[field]?.find((item) => item.key === row.key)?.id ?? row.id }));
		}
		return { ...server, id: original.id, maps,
			...(server.args && { args: server.args.map((arg, index) => ({ ...arg, id: original.args?.[index]?.id ?? arg.id })) }),
		};
	}) };
	return { ...restored, draft, baselineDraft: draft };
}

export function mcpEditorContent(editor: McpEditor): string | undefined {
	if (editor.mode === "source") return editor.content;
	if (!mcpDraftSerializable(editor.draft)) return undefined;
	// 比较实际配置，不包含行 ID 等界面状态。没有修改时保留原文格式。
	const content = writeMcpDraft(editor.draft);
	return content === editor.baseline ? editor.source : content;
}
