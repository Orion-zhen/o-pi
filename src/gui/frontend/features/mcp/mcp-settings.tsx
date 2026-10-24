import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Copy, Import, Plus, Server } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { mcpObject, validateMcpConfig } from "../../../shared/config/mcp-validation.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { Switch } from "@/ui/switch.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import { ConfirmAction } from "@/ui/confirm-action.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { useConfigDraft } from "@/forms/use-config-draft.ts";
import { SettingsSection, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import { copyMcpServer, createMcpServer, mcpDraftIssues, mcpServerSummary, nextMcpName, type McpDraft, type McpServerDraft } from "./mcp-draft.ts";
import { discardMcpEditor, mcpDraftChanged, mcpEditorView, readMcpEditor, readMcpSource } from "./mcp-editor.ts";
import { McpServerForm } from "./mcp-server-form.tsx";
import { McpImport } from "./mcp-import.tsx";
import "./mcp-settings.css";

export function McpSettings({ query, send, disabled }: { query: Query<GlobalQuery>; send: Send; disabled: boolean }) {
	const editor = useConfigDraft(useCallback(() => query({ query: "mcpConfig" }), [query]), readMcpEditor);
	const { document, error } = editor;
	const { saving } = useSettingsState();
	const [expanded, setExpanded] = useState<number>();
	const [importing, setImporting] = useState(false);
	const state = editor.draft;
	const sourceView = state.mode === "source";
	const { content, value } = useMemo(() => mcpEditorView(state), [state]);
	const original = useMemo(() => readMcpSource(document?.content ?? "", document?.content ?? "").value, [document?.content]);
	const dirty = document !== undefined && content !== document.content && (state.sourceEdited || mcpDraftChanged(original, value));
	const blocked = disabled || saving;
	const sourceErrors = state.mode === "source" ? (state.value ? validateMcpConfig(state.value) : [state.error]) : [];
	const servers = state.mode === "form" ? mcpDraftIssues(state.draft.servers) : [];
	const rootErrors = state.mode === "form" ? validateMcpConfig(state.draft.root) : [];
	const invalid = sourceView ? sourceErrors.length > 0 : rootErrors.length > 0 || servers.some(({ issues }) => issues.length > 0);
	const discard = () => {
		if (document) editor.change(discardMcpEditor(document.content, state));
		setImporting(false);
	};
	useSettingsDraft("mcp", {
		title: "MCP 服务", dirty, blocked: disabled, invalid,
		save: async () => {
			if (content === undefined) return false;
			const saved = await editor.save(content, async (document, content) => await send({ action: "saveMcpConfig", original: document.content, content })
				? { ...document, content } : undefined);
			if (saved) editor.change(state.mode === "form"
				? { ...state, source: content, baselineDraft: state.draft, sourceEdited: false }
				: { ...state, sourceEdited: false });
			return saved;
		},
		discard,
	});
	let form: ReactNode;
	if (state.mode === "form") {
		const { draft } = state;
		const changeDraft = (draft: McpDraft) => editor.change({ ...state, draft });
		const changeServer = (server: McpServerDraft) => changeDraft({ ...draft, servers: draft.servers.map((item) => item.id === server.id ? server : item) });
		const add = (base?: McpServerDraft) => {
			const name = nextMcpName(draft, base ? `${base.name}-copy` : undefined);
			const server = base ? copyMcpServer(base, name) : createMcpServer(name, { command: "" });
			changeDraft({ ...draft, servers: [...draft.servers, server] }); setExpanded(server.id); setImporting(false);
		};
		form = <>
			<div className="mcp-toolbar"><span className="settings-description">{draft.servers.length} 个服务</span>
				<div className="settings-action-buttons"><Button variant="outline" size="sm" disabled={blocked} onClick={() => setImporting(!importing)}><Import />导入配置</Button>
					<Button size="sm" disabled={blocked} onClick={() => add()}><Plus />添加服务</Button></div>
			</div>
			<AnimatePresence initial={false}>{importing && <Reveal key="import"><McpImport draft={draft} disabled={blocked} apply={(next) => { changeDraft(next); setImporting(false); }} cancel={() => setImporting(false)} /></Reveal>}</AnimatePresence>
			<div className="mcp-server-list"><AnimatePresence initial={false}>
				{draft.servers.length === 0 && <Reveal key="empty"><div className="mcp-empty"><Server aria-hidden="true" /><strong>连接你的工具与数据</strong><p>添加本地进程或远程 HTTP 服务，也可以直接导入已有配置。</p></div></Reveal>}
				{servers.map(({ server, issues }) => {
					const config = mcpObject(server.config) ? server.config : {};
					const open = expanded === server.id;
					const name = server.name || "未命名服务";
					const remote = config.type === "http" || config.type === "streamable-http" || (config.type === undefined && "url" in config);
					return <Reveal key={server.id} className="mcp-server-entry"><Collapsible open={open} onOpenChange={(next) => setExpanded(next ? server.id : undefined)} asChild>
						<article className="mcp-server" aria-label={`MCP 服务 ${name}`}>
							<div className="mcp-server-heading">
								<CollapsibleTrigger asChild><button type="button" className="mcp-server-summary" aria-label={`编辑 ${name}`}>
									<span className="mcp-server-name">{name}{issues.length > 0 && <span className="mcp-error-badge">需修复</span>}</span>
									<span className="mcp-server-address">{remote ? "HTTP" : "本地进程"} · <span>{mcpServerSummary(server)}</span></span>
								</button></CollapsibleTrigger>
								<div className="mcp-server-actions">
									<Switch aria-label={name} checked={config.enabled !== false} disabled={blocked || !mcpObject(server.config)} onCheckedChange={(enabled) => {
										const next = { ...config }; if (enabled) delete next.enabled; else next.enabled = false;
										changeServer({ ...server, config: next });
									}} />
									<IconButton size="icon-sm" label={`复制服务 ${name}`} tooltip="复制服务" disabled={blocked} onClick={() => add(server)}><Copy /></IconButton>
									<ConfirmAction label={`删除服务 ${name}`} tooltip="删除服务 · 保存生效" disabled={blocked} allowShortcut
										confirm={async () => { changeDraft({ ...draft, servers: draft.servers.filter(({ id }) => id !== server.id) }); }} />
									<CollapsibleTrigger className="disclosure-trigger" asChild><Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"} ${name}`}><ChevronRight className="disclosure-chevron" /></Button></CollapsibleTrigger>
								</div>
							</div>
							<CollapsibleContent lazy><McpServerForm server={server} issues={issues} disabled={blocked} change={changeServer} /></CollapsibleContent>
						</article>
					</Collapsible></Reveal>;
				})}</AnimatePresence></div>
			{rootErrors.map((message) => <p role="alert" key={message}>{message} 请使用 JSON 修复。</p>)}
			{content === undefined && <p role="alert">请修正重复的服务名或键，再切换 JSON。</p>}
		</>;
	}
	return <SettingsSection title="MCP 服务" actions={document && <SettingsSourceButton file={document.path} source={sourceView} disabled={blocked || content === undefined || (sourceView && value === undefined)} onClick={() => {
		if (content === undefined) return;
		const next = dirty ? content : document.content;
		const sourceEdited = dirty && state.sourceEdited;
		editor.change(sourceView ? readMcpEditor(next, sourceEdited) : readMcpSource(next, document.content, sourceEdited));
		setImporting(false); setExpanded(undefined);
	}} />}>
		{!document ? <>
			{error ? <p role="alert">{error}</p> : <p role="status">读取中…</p>}
			{error && <Button variant="ghost" onClick={editor.reload}>重试</Button>}
		</> : <>
			<p className="settings-description">全局配置 · 新会话或 /reload 后生效。此处开关不表示连接状态。</p>
			{sourceView ? <>
				<p className="settings-warning">JSON 会显示明文凭据。语法损坏时请先修复，再切换到表单。</p>
				<Textarea className="settings-source" aria-label="全局 MCP JSON" value={content} disabled={blocked} onChange={(event) => editor.change(readMcpSource(event.target.value, document.content))} />
				{sourceErrors.map((message, index) => <p role="alert" key={index}>{message}</p>)}
			</> : form}
			<p className="settings-description">仅配置可信服务。遮蔽不加密配置文件，凭据建议使用 ${"{ENV_NAME}"}。受信任项目的同名配置可能覆盖全局配置。</p>
			{dirty && <p className="settings-description">修改尚未保存，请使用设置页的“保存”。</p>}
			{error && <p role="alert">{error}</p>}
		</>}
	</SettingsSection>;
}
