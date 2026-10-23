import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import type { Query } from "../../../../shared/protocol/queries.ts";
import { editModelsDocument } from "../../../../../harness/openai-compatible-provider/config-edits.ts";
import { emptyModelsDocument, isCompatibleService } from "../../../../../harness/openai-compatible-provider/document.ts";
import { modelsConfigIssues } from "../../../../../harness/openai-compatible-provider/validation.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import { SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useConfigDraft } from "@/forms/use-config-draft.ts";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import { AddServiceItem } from "./add-service-item.tsx";
import { parseServiceDraft, serviceDraftChanged } from "./service-draft.ts";
import { ServiceItem } from "./service-item.tsx";
import type { CatalogQuery } from "./use-service-catalog.ts";
import "./model-services.css";

export function ModelServicesSettings({ globalQuery, query, send, disabled, sessionId, sessionRevision, sessionReady }: {
	globalQuery: Query<{ query: "modelServices" }>;
	query: CatalogQuery;
	send: Send;
	disabled: boolean;
	sessionId: string | undefined;
	sessionRevision: number | undefined;
	sessionReady: boolean;
}) {
	const editor = useConfigDraft(useCallback(() => globalQuery({ query: "modelServices" }), [globalQuery]), String);
	const { document, draft, error } = editor;
	const { saving } = useSettingsState();
	const [source, setSource] = useState(false);
	// 源码编辑保留注释和格式修改，表单只比较配置值。
	const [sourceEdited, setSourceEdited] = useState(false);
	const [adding, setAdding] = useState(false);
	const addButton = useRef<HTMLButtonElement>(null);
	const cancel = () => { setAdding(false); addButton.current?.focus(); };
	const [expanded, setExpanded] = useState<string>();
	const parsed = useMemo(() => parseServiceDraft(draft === "" && document?.content === "" ? emptyModelsDocument : draft),
		[draft, document?.content]);
	const issues = useMemo(() => parsed.value && document ? modelsConfigIssues(parsed.value, document.schema) : [], [parsed.value, document]);
	const dirty = useMemo(() => document !== undefined && (sourceEdited ? draft !== document.content : serviceDraftChanged(document.content, draft)),
		[document, draft, sourceEdited]);
	const blocked = disabled || saving;
	const sourceView = source || !!parsed.error;
	if (document && parsed.error && !source) setSource(true);

	async function save() {
		const saved = await editor.save(draft, async (document, content) => {
			const success = await send({ action: "saveModelServices", original: document.content, content });
			return success ? { ...document, content } : undefined;
		});
		if (saved) setSourceEdited(false);
		return saved;
	}
	function discard() {
		editor.discard();
		setSourceEdited(false);
		setAdding(false);
	}
	function toggleSource() {
		if (!dirty) editor.discard();
		setSource(!sourceView);
		setAdding(false);
	}
	function addService(id: string) {
		editor.change((current) => editModelsDocument(current, ["providers", id], { baseUrl: "", api: "openai-completions" }));
		setExpanded(id);
		setAdding(false);
	}
	useSettingsDraft("modelServices", {
		title: "模型服务", dirty, blocked: disabled, invalid: !!parsed.error || issues.length > 0, save, discard,
	});
	const saved = useMemo(() => parseServiceDraft(document?.content || emptyModelsDocument).value, [document?.content]);
	const providers = parsed.value?.providers ?? {};
	const services = Object.entries(providers).filter(([, config]) => isCompatibleService(config));

	return <section className="settings-section" aria-label="OpenAI 兼容服务">
		<header className="settings-group-heading">
			<h3>OpenAI 兼容服务</h3>
			{document && <div className="settings-heading-actions">
				{!sourceView && <Button ref={addButton} variant="outline" size="sm" disabled={blocked} aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus />添加服务</Button>}
				<SettingsSourceButton file={document.path} source={sourceView} disabled={blocked || !!parsed.error} onClick={toggleSource} />
			</div>}
		</header>
		<p className="settings-description">保存后使用“重载资源”或 /reload 应用到当前会话。</p>
		{!document ? <>
			{error ? <><p role="alert">{error}</p><Button variant="ghost" onClick={editor.reload}>重试</Button></> : <p role="status">读取中…</p>}
		</> : <>
			{sourceView ? <Textarea className="settings-source" aria-label="模型服务 JSON" value={draft} disabled={blocked} spellCheck={false}
				onChange={(event) => { setSourceEdited(true); editor.change(event.target.value); }} /> : <>
				<AnimatePresence initial={false}>{adding && <Reveal key="add">
					<AddServiceItem label="服务 ID" existing={Object.keys(providers)} disabled={blocked} cancel={cancel} add={addService} />
				</Reveal>}</AnimatePresence>
				<div className="model-service-list"><AnimatePresence initial={false}>
					{services.map(([id, config]) => <ServiceItem key={id} id={id} config={config} disabled={blocked}
						open={expanded === id} setOpen={(open) => setExpanded(open ? id : undefined)}
						savedConfig={saved?.providers[id]} sessionId={sessionId} sessionRevision={sessionRevision} sessionReady={sessionReady}
						query={query} changeDraft={editor.change} />)}
				</AnimatePresence></div>
				{!services.length && !adding && <p className="settings-empty">暂无服务</p>}
			</>}
			{[parsed.error, ...issues, error].filter(Boolean).map((message, index) => <p role="alert" key={index}>{message}</p>)}
		</>}
	</section>;
}
