import { useCallback } from "react";
import type { GlobalQuery, Query } from "../../contract.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { useConfigDraft } from "./config-draft.tsx";
import { SettingsSection } from "./settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "./settings-state.tsx";

export function McpSettings({ query, send, disabled }: { query: Query<GlobalQuery>; send: Send; disabled: boolean }) {
	const editor = useConfigDraft(useCallback(() => query({ query: "mcpConfig" }), [query]));
	const { document, draft, dirty, error } = editor;
	const { saving } = useSettingsState();
	useSettingsDraft("mcp", {
		title: "MCP 服务", dirty, blocked: disabled,
		save: () => editor.save(async (document, content) =>
			await send({ action: "saveMcpConfig", original: document.content, content }) ? { ...document, content, errors: [] } : undefined),
		discard: editor.discard,
	});
	return <SettingsSection title="MCP 服务" actions={<span className="settings-badge">新会话或 /reload 生效</span>}>
		{!document ? <>
			{error ? <p role="alert">{error}</p> : <p role="status">读取中…</p>}
			{error && <Button variant="ghost" onClick={editor.reload}>重试</Button>}
		</> : <>
			{document.errors.map((message) => <p role="alert" key={message}>{message}</p>)}
			<Textarea className="settings-source" aria-label="全局 MCP JSON" value={draft} disabled={disabled || saving}
				onChange={(event) => editor.change(event.target.value)} />
			{error && <p role="alert">{error}</p>}
		</>}
	</SettingsSection>;
}
