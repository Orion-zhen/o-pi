import { useCallback, useEffect } from "react";
import type { GlobalQuery, Query } from "../../contract.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { useConfigDraft } from "./config-draft.tsx";
import { SettingsActions, SettingsHeading } from "./settings-controls.tsx";

export function McpSettings({ title, query, send, disabled, onDirty }: {
	title: string; query: Query<GlobalQuery>; send: Send; disabled: boolean; onDirty: (id: "mcp", dirty: boolean) => void;
}) {
	const editor = useConfigDraft(useCallback(() => query({ query: "mcpConfig" }), [query]));
	const { document, draft, dirty, error, saving } = editor;
	useEffect(() => { onDirty("mcp", dirty); }, [dirty, onDirty]);
	useEffect(() => () => onDirty("mcp", false), [onDirty]);
	if (!document) return <div className="gui-settings"><SettingsHeading title={title} />
		{error ? <p role="alert">{error}</p> : <p role="status">正在读取 MCP 配置…</p>}
		<div className="settings-action-buttons"><Button variant="ghost" onClick={editor.reload}>重新读取</Button></div>
	</div>;
	return <div className="gui-settings">
		<SettingsHeading title={title} />
		<p className="settings-description">编辑全局 mcp.json。服务使用 enabled 开关，工具使用 exposure 和 toolExposure 配置暴露方式。保存后需新建会话或执行 /reload。</p>
		<p className="settings-description">当前会话的工具可见性在工具选择器中调整，不修改此配置。此处仅检查 JSON 结构，服务字段由 SDK 加载时校验。</p>
		<p className="settings-warning">仅配置可信服务。凭据建议使用 ${'{ENV_NAME}'} 引用，不直接填写密钥。</p>
		<p className="settings-path">{document.path}</p>
		{document.errors.map((message) => <p role="alert" key={message}>{message}</p>)}
		<Textarea className="settings-source" aria-label="全局 MCP JSON" value={draft} disabled={disabled || saving}
			onChange={(event) => editor.change(event.target.value)} />
		<SettingsActions {...editor} disabled={disabled} save={() => void editor.save(async (document, content) =>
			await send({ action: "saveMcpConfig", original: document.content, content })
				? { ...document, content, errors: [] } : undefined, "已保存。新会话或 /reload 后生效。")} />
	</div>;
}
