import { useState } from "react";
import { mcpNameConflict } from "../../mcp-validation.ts";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { importMcpServers, mcpDraftIssues, mcpServerSummary, type McpDraft, type McpServerDraft } from "./mcp-draft.ts";

export function McpImport({ draft, disabled, apply, cancel }: {
	draft: McpDraft; disabled: boolean; apply: (draft: McpDraft) => void; cancel: () => void;
}) {
	const [text, setText] = useState("");
	const [servers, setServers] = useState<McpServerDraft[]>();
	const [replace, setReplace] = useState(new Set<number>());
	const [error, setError] = useState("");
	const preview = servers?.map((server) => {
		const errors = mcpDraftIssues({ root: {}, servers }, server).map(({ message }) => message);
		const conflict = mcpNameConflict(server.name, draft.servers.map(({ name }) => name));
		if (conflict !== undefined && (conflict !== server.name || !replace.has(server.id))) errors.push(`与已有服务 ${conflict} 冲突，请改名${conflict === server.name ? "或确认替换" : ""}。`);
		return { server, errors };
	});
	return <fieldset className="mcp-import" disabled={disabled}>
		<div className="mcp-field-heading"><strong>导入服务</strong><Button variant="ghost" size="sm" onClick={cancel}>取消导入</Button></div>
		<p className="settings-description">粘贴完整 mcpServers 或单个服务对象。只导入服务，不改动全局选项，不执行命令或建立连接。</p>
		{!preview ? <>
			<Textarea className="settings-source" aria-label="导入 MCP JSON" value={text} onChange={(event) => { setText(event.target.value); setError(""); }} placeholder={'{"mcpServers": {"docs": {"url": "https://example.com/mcp"}}}'} />
			<Button variant="outline" size="sm" onClick={() => {
				let imported: McpServerDraft[];
				try { imported = importMcpServers(text); }
				catch (error) { setError(error instanceof Error ? error.message : String(error)); return; }
				setServers(imported); setError("");
			}}>预览导入</Button>
		</> : <>
			{preview.map(({ server, errors }, index) => <div className="mcp-import-row" key={server.id}>
				<Input aria-label={`导入服务名称 ${index + 1}`} value={server.name} onChange={(event) => {
					setServers(preview.map(({ server: item }) => item.id === server.id ? { ...item, name: event.target.value } : item));
					setReplace(new Set([...replace].filter((id) => id !== server.id)));
				}} />
				<span className="settings-description">{mcpServerSummary(server)}</span>
				{draft.servers.some(({ name }) => name === server.name) && <label className="mcp-replace"><Checkbox aria-label={`替换 ${server.name}`} checked={replace.has(server.id)} onCheckedChange={(checked) => setReplace((previous) => {
					const next = new Set(previous); if (checked === true) next.add(server.id); else next.delete(server.id); return next;
				})} />替换已有服务</label>}
				{errors.map((message, index) => <p role="alert" key={index}>{message}</p>)}
			</div>)}
			<div className="settings-action-buttons"><Button size="sm" disabled={preview.some(({ errors }) => errors.length > 0)} onClick={() => {
				const next = [...draft.servers];
				for (const { server } of preview) {
					const index = next.findIndex(({ name }) => name === server.name);
					const existing = next[index];
					if (existing) next[index] = { ...server, id: existing.id };
					else next.push(server);
				}
				apply({ ...draft, servers: next });
			}}>导入到草稿</Button><Button variant="ghost" size="sm" onClick={() => { setServers(undefined); setReplace(new Set()); }}>返回修改 JSON</Button></div>
		</>}
		{error && <p role="alert">{error}</p>}
	</fieldset>;
}
