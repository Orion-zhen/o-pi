import { useEffect, useState } from "react";
import type { GlobalQuery, Query } from "../contract.ts";
import type { McpConfigDocument } from "../mcp.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

export function McpSettings({ query, send, disabled, onDirty }: {
	query: Query<GlobalQuery>; send: Send; disabled: boolean; onDirty: (id: "mcp", dirty: boolean) => void;
}) {
	const [document, setDocument] = useState<McpConfigDocument>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [revision, setRevision] = useState(0);
	const [saving, setSaving] = useState(false);
	const dirty = document !== undefined && draft !== document.content;
	useEffect(() => { onDirty("mcp", dirty); }, [dirty, onDirty]);
	useEffect(() => () => onDirty("mcp", false), [onDirty]);
	useEffect(() => {
		let active = true;
		void query({ query: "mcpConfig" }).then((value) => {
			if (active) { setDocument(value); setDraft(value.content); setError(""); }
		}, (error: unknown) => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [query, revision]);
	const blocked = disabled || saving;
	if (!document) return <div>{error ? <p role="alert">{error}</p> : <p role="status">正在读取 MCP 配置…</p>}<Button variant="outline" onClick={() => setRevision(revision + 1)}>重新读取</Button></div>;
	const save = async () => {
		setSaving(true); setError(""); setStatus("");
		try {
			if (await send({ action: "saveMcpConfig", original: document.content, content: draft })) {
				setDocument({ ...document, content: draft, errors: [] });
				setStatus("已保存。新会话或 /reload 后生效。");
			} else setError("保存失败，请查看错误通知。草稿已保留。");
		} finally { setSaving(false); }
	};
	return <div className="gui-settings module-settings">
		<p>编辑全局 mcp.json。服务使用 enabled 开关，工具使用 exposure 和 toolExposure 配置暴露方式。保存后需新建会话或执行 /reload。</p>
		<p>当前会话的工具可见性在工具选择器中调整，不修改此配置。此处仅检查 JSON 结构，服务字段由 SDK 加载时校验。</p>
		<p className="settings-warning">仅配置可信服务。凭据建议使用 ${'{ENV_NAME}'} 引用，不直接填写密钥。</p>
		<small>{document.path}</small>
		{document.errors.map((message) => <p role="alert" key={message}>{message}</p>)}
		<Textarea className="module-source" aria-label="全局 MCP JSON" value={draft} disabled={blocked}
			onChange={(event) => { setDraft(event.target.value); setStatus(""); }} />
		{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
		<div className="toolbar module-actions">
			<Button disabled={blocked || !dirty} onClick={() => void save()}>保存</Button>
			<Button variant="outline" disabled={blocked || !dirty} onClick={() => { setDraft(document.content); setError(""); setStatus(""); }}>放弃修改</Button>
			<Button variant="ghost" disabled={blocked || dirty} onClick={() => { setStatus(""); setRevision(revision + 1); }}>重新读取</Button>
			{dirty && <span role="status">有未保存修改</span>}
		</div>
	</div>;
}
