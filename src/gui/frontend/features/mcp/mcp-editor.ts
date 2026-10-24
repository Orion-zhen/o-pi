import { equalConfigValues } from "../../../../harness/config-values.ts";
import { mcpObject, parseMcpConfig, type McpConfig } from "../../../shared/config/mcp-validation.ts";
import { createMcpDraft, mcpDraftSerializable, mcpDraftValue, mcpMapFields, type McpDraft } from "./mcp-draft.ts";

export type McpEditor = { sourceEdited: boolean } & (
	| { mode: "source"; content: string; value: McpConfig | undefined; error: string }
	| { mode: "form"; draft: McpDraft; baselineDraft: McpDraft; source: string }
);

export function readMcpSource(content: string, original: string, sourceEdited = content !== original): Extract<McpEditor, { mode: "source" }> {
	try {
		const value = parseMcpConfig(content === "" && original === "" ? "{}" : content);
		return { mode: "source", content, value, error: "", sourceEdited };
	} catch (error) {
		// 损坏配置保留原文，交给 JSON 编辑器修复。
		return { mode: "source", content, value: undefined, error: error instanceof Error ? error.message : String(error), sourceEdited };
	}
}

export function readMcpEditor(content: string, sourceEdited = false): McpEditor {
	const source = readMcpSource(content, content, sourceEdited);
	if (!source.value) return source;
	const draft = createMcpDraft(source.value);
	return { mode: "form", draft, baselineDraft: draft, source: content, sourceEdited };
}

export function discardMcpEditor(content: string, editor: McpEditor): McpEditor {
	if (editor.mode === "source") return readMcpSource(content, content);
	if (content === editor.source) return { ...editor, draft: editor.baselineDraft, sourceEdited: false };
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

function comparableConfig({ mcpServers, ...root }: McpConfig): unknown {
	return { ...root, mcpServers: Object.fromEntries(Object.entries(mcpServers ?? {}).map(([name, raw]) => {
		if (!mcpObject(raw)) return [name, raw];
		const value = { ...raw };
		if (value.enabled === true) delete value.enabled;
		if (value.timeout === 60) delete value.timeout;
		if (value.exposure === "codemode" || value.exposure === "codemode-deferred") delete value.exposure;
		if (value.type === "streamable-http" || value.type === undefined && typeof value.url === "string") value.type = "http";
		else if (value.type === undefined && typeof value.command === "string") value.type = "stdio";
		for (const field of ["cwd", "description"]) if (value[field] === "") delete value[field];
		if (Array.isArray(value.args) && !value.args.length) delete value.args;
		for (const field of ["env", "headers", "toolExposure", "oauth"]) {
			const entry = value[field];
			if (!mcpObject(entry)) continue;
			const map = { ...entry };
			if (field === "oauth" && map.clientRegistration === "dcr") delete map.clientRegistration;
			if (!Object.keys(map).length) delete value[field];
			// 工具通配规则按顺序匹配，不能像普通对象一样忽略键顺序。
			else value[field] = field === "toolExposure" ? Object.entries(map).map(([key, exposure]) => [key, exposure === "codemode-deferred" ? "codemode" : exposure]) : map;
		}
		return [name, value];
	})) };
}

export function mcpDraftChanged(before: McpConfig | undefined, after: McpConfig | undefined): boolean {
	return before === undefined || after === undefined || !equalConfigValues(comparableConfig(before), comparableConfig(after));
}

export function mcpEditorView(editor: McpEditor): { content: string | undefined; value: McpConfig | undefined } {
	if (editor.mode === "source") return { content: editor.content, value: editor.value };
	if (!mcpDraftSerializable(editor.draft)) return { content: undefined, value: undefined };
	const value = mcpDraftValue(editor.draft);
	// 比较实际配置，不包含行 ID 等界面状态。没有修改时保留原文格式。
	const changed = mcpDraftChanged(mcpDraftValue(editor.baselineDraft), value);
	return { content: changed ? `${JSON.stringify(value, null, 2)}\n` : editor.source, value };
}
