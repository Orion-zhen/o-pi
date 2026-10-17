import { useCallback, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Plus } from "lucide-react";
import type { GlobalQuery, Query } from "../../contract.ts";
import { isCompatibleService } from "../../model-services.ts";
import { modelsConfigIssues, parseModelsDocument } from "../../../harness/openai-compatible-provider/validation.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { Reveal } from "../components/animated.tsx";
import { SettingsSourceButton } from "../settings/settings-controls.tsx";
import { useConfigDraft } from "../settings/use-config-draft.ts";
import { useSettingsDraft, useSettingsState } from "../settings/settings-state.tsx";
import { AddServiceItem, textValue } from "./service-fields.tsx";
import { editServiceConfig, serviceAddress, type ChangeConfig } from "./service-draft.ts";
import { ServiceForm } from "./service-form.tsx";
import "./model-services.css";

export function ModelServicesSettings({ globalQuery, query, send, disabled, sessionId, canRefresh }: {
	globalQuery: Query<GlobalQuery>; query: Query; send: Send; disabled: boolean; sessionId: string | undefined; canRefresh: boolean;
}) {
	const editor = useConfigDraft(useCallback(() => globalQuery({ query: "modelServices" }), [globalQuery]), String);
	const { document, draft, error } = editor;
	const { saving } = useSettingsState();
	const [source, setSource] = useState(false);
	const [adding, setAdding] = useState(false);
	const [expanded, setExpanded] = useState<string>();
	const parsed = useMemo(() => {
		try { return { value: parseModelsDocument(draft === "" && document?.content === "" ? '{"providers":{}}' : draft), error: "" }; }
		catch (error) { return { value: undefined, error: error instanceof Error ? error.message : String(error) }; }
	}, [draft, document?.content]);
	const issues = parsed.value && document ? modelsConfigIssues(parsed.value, document.schema) : [];
	const dirty = document !== undefined && draft !== document.content;
	const blocked = disabled || saving;
	const sourceView = source || !!parsed.error;
	if (document && parsed.error && !source) setSource(true);
	useSettingsDraft("modelServices", {
		title: "模型服务", dirty, blocked: disabled, invalid: !!parsed.error || issues.length > 0,
		save: () => editor.save(draft, async (document, content) =>
			await send({ action: "saveModelServices", original: document.content, content }) ? { ...document, content } : undefined),
		discard: () => { editor.discard(); setAdding(false); setExpanded(undefined); },
	});
	const change: ChangeConfig = (path, value) => editor.change(editServiceConfig(draft, path, value));
	const services = Object.entries(parsed.value?.providers ?? {}).filter(([, config]) => isCompatibleService(config));
	return <section className="settings-section" aria-label="OpenAI 兼容服务">
		<header className="settings-group-heading"><h3>OpenAI 兼容服务</h3>
			{document && <div className="settings-heading-actions">
				{!sourceView && <Button variant="outline" size="sm" disabled={blocked} onClick={() => setAdding(!adding)}><Plus />添加服务</Button>}
				<SettingsSourceButton file={document.path} source={sourceView} disabled={blocked || !!parsed.error} onClick={() => { setSource(!sourceView); setAdding(false); }} />
			</div>}
		</header>
		<p className="settings-description">保存后使用“重载资源”或 /reload 应用到当前会话。</p>
		{!document ? <>{error ? <><p role="alert">{error}</p><Button variant="ghost" onClick={editor.reload}>重试</Button></> : <p role="status">读取中…</p>}</> : <>
			{sourceView ? <Textarea className="settings-source" aria-label="模型服务 JSON" value={draft} disabled={blocked} spellCheck={false} onChange={(event) => editor.change(event.target.value)} /> : <>
				<AnimatePresence initial={false}>{adding && <Reveal key="add"><AddServiceItem label="服务 ID" existing={Object.keys(parsed.value?.providers ?? {})} disabled={blocked} cancel={() => setAdding(false)} add={(id) => {
					change(["providers", id], { baseUrl: "", api: "openai-completions" }); setExpanded(id); setAdding(false);
				}} /></Reveal>}</AnimatePresence>
				<div className="model-service-list"><AnimatePresence initial={false}>
					{services.map(([id, config]) => {
						const open = expanded === id;
						const name = textValue(config.name) || id;
						return <Reveal key={id}><Collapsible open={open} onOpenChange={(next) => setExpanded(next ? id : undefined)} asChild>
							<article className="model-service" aria-label={`模型服务 ${id}`}>
								<div className="service-item-heading"><CollapsibleTrigger className="service-summary" aria-label={`编辑服务 ${id}`}>
									<strong>{name}</strong><span>{id}{serviceAddress(config.baseUrl) ? ` · ${serviceAddress(config.baseUrl)}` : ""}</span>
								</CollapsibleTrigger><span className="service-tag">{config.api === "openai-responses" ? "Responses" : "Chat Completions"}</span>
									<div className="service-item-actions"><ConfirmAction label={`删除服务 ${id}`} disabled={blocked} confirm={async () => change(["providers", id], undefined)} />
										<CollapsibleTrigger className="disclosure-trigger" asChild><Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"}服务 ${id}`}><ChevronRight className="disclosure-chevron" /></Button></CollapsibleTrigger>
									</div>
								</div>
								<CollapsibleContent lazy><ServiceForm id={id} config={config} disabled={blocked} canRefresh={canRefresh && !dirty}
									savedContent={document.content} sessionId={sessionId} query={query} send={send} change={(path, value) => change(["providers", id, ...path], value)} /></CollapsibleContent>
							</article>
						</Collapsible></Reveal>;
					})}
				</AnimatePresence></div>
				{!services.length && !adding && <p className="settings-empty">暂无服务</p>}
			</>}
			{[parsed.error, ...issues, error].filter(Boolean).map((message, index) => <p role="alert" key={index}>{message}</p>)}
		</>}
	</section>;
}
