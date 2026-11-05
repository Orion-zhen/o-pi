import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import type { Query } from "../../../../shared/protocol/queries.ts";
import { editModelsDocument } from "../../../../../harness/model-services/config-edits.ts";
import { emptyModelsDocument } from "../../../../../harness/model-services/document.ts";
import { modelsConfigIssues } from "../../../../../harness/model-services/validation.ts";
import type { ConfigCommand } from "@/connection/connection.ts";
import type { ModelServicesDocument } from "../../../../shared/config/model-services.ts";
import { ConfigDocument } from "@/forms/config-document.tsx";
import { Button } from "@/ui/button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { SourceEditor } from "@/forms/source-editor.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import { SettingsHeading, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useTextConfigDraft } from "@/forms/use-text-config-draft.ts";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import { AddServiceItem } from "./add-service-item.tsx";
import { parseServiceDraft, serviceDraftChanged } from "./service-draft.ts";
import { ServiceItem } from "./service-item.tsx";
import { ModelApiChoicesContext } from "./service-fields.tsx";
import type { CatalogQuery } from "./use-service-catalog.ts";
import "./model-services.css";

interface Props {
	globalQuery: Query<{ query: "modelServices" }>;
	query: CatalogQuery;
	send: ConfigCommand;
	disabled: boolean;
	sessionId: string | undefined;
	sessionRevision: number | undefined;
	sessionReady: boolean;
}
export function ModelServicesSettings({ globalQuery, ...props }: Props) {
	const load = useCallback(() => globalQuery({ query: "modelServices" }), [globalQuery]);
	return <ConfigDocument title="模型服务" load={load}>{(initial) => <ModelServicesEditor {...props} initial={initial} />}</ConfigDocument>;
}

function ModelServicesEditor({ initial, query, send, disabled, sessionId, sessionRevision, sessionReady }: Omit<Props, "globalQuery"> & { initial: ModelServicesDocument }) {
	const editor = useTextConfigDraft(initial);
	const { document, draft } = editor;
	const { saving } = useSettingsState();
	const [adding, setAdding] = useState(false);
	const addButton = useRef<HTMLButtonElement>(null);
	const cancel = () => { setAdding(false); addButton.current?.focus(); };
	const [expanded, setExpanded] = useState<string>();
	const parsed = useMemo(() => parseServiceDraft(draft === "" && document.content === "" ? emptyModelsDocument : draft),
		[draft, document.content]);
	const issues = useMemo(() => parsed.value ? modelsConfigIssues(parsed.value, document.schema) : [], [parsed.value, document]);
	const saved = useMemo(() => parseServiceDraft(document.content || emptyModelsDocument).value, [document.content]);
	const dirty = useMemo(() => draft !== document.content
		&& (editor.sourceEdited || serviceDraftChanged(saved, parsed.value)), [document, draft, editor.sourceEdited, saved, parsed.value]);
	const blocked = disabled || saving;
	const invalid = !!parsed.error || issues.length > 0;
	const [sourceView, setSource] = useState(invalid);

	async function save() {
		return editor.save(draft, async (document, content) => {
			await send({ action: "saveModelServices", original: document.content, content });
			return { ...document, content };
		});
	}
	function discard() {
		editor.discard();
		if (!saved || modelsConfigIssues(saved, document.schema).length > 0) setSource(true);
		setAdding(false);
	}
	function toggleSource() {
		if (!dirty) editor.discard();
		setSource(!sourceView);
		setAdding(false);
	}
	function addService(id: string) {
		editor.change((current) => editModelsDocument(current, ["providers", id], { baseUrl: "", api: "" }));
		setExpanded(id);
		setAdding(false);
	}
	useSettingsDraft("modelServices", {
		title: "模型服务", blocked: disabled,
		plan: !dirty ? { state: "clean" } : invalid ? { state: "invalid" } : { state: "ready", save }, discard,
	});
	const providers = parsed.value?.providers ?? {};
	const services = Object.entries(providers);

	return <section className="settings-module" aria-label="模型服务">
		<SettingsHeading title="模型服务">
			{!sourceView && <Button ref={addButton} variant="outline" size="sm" disabled={blocked} aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus />添加服务</Button>}
			<SettingsSourceButton file={document.path} source={sourceView} disabled={blocked || sourceView && invalid} onClick={toggleSource} />
		</SettingsHeading>
		<div className="settings-section"><ModelApiChoicesContext value={document.apis}>
			{sourceView ? <SourceEditor file={document.path} label="模型服务 JSON" value={draft} disabled={blocked} onChange={editor.changeSource} /> : <>
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
			<Feedback message={[parsed.error, ...issues].filter(Boolean).join("\n")} tone="error" />
		</ModelApiChoicesContext></div>
	</section>;
}
