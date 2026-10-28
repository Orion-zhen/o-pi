import { useCallback, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "@/ui/icon-button.tsx";
import { applyEdits, modify } from "jsonc-parser";
import { parseModuleDraft, readModuleConfig } from "./module-draft.ts";
import { equalConfigValues } from "../../../../harness/config-values.ts";
import type { GuiModel, GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Query, GlobalQuery } from "../../../shared/protocol/queries.ts";
import type { ModuleConfigId } from "../../../shared/config/modules.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { SourceEditor } from "@/forms/source-editor.tsx";
import { moduleGroups, type ConfigField } from "./module-fields.ts";
import { FieldControl } from "./field-control.tsx";
import { useTextConfigDraft } from "@/forms/use-text-config-draft.ts";
import { SettingsDisclosure, SettingsSection, SettingsRow, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import { SearchProviderSettings } from "./search-provider-settings.tsx";
import { SearchApiKeyControl } from "./search-api-key-control.tsx";

function at(value: unknown, path: string): unknown {
	for (const key of path.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function ModuleSettings({ title, id, query, send, disabled, models, tools, currentModel }: {
	title: string; id: ModuleConfigId; query: Query<GlobalQuery>; send: Send; disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; currentModel: GuiModel | null;
}) {
	const editor = useTextConfigDraft(useCallback(() => query({ query: "moduleConfig", id }), [id, query]));
	const { document, draft, error } = editor;
	const { saving } = useSettingsState();
	const [source, setSource] = useState(false);
	const defaults = useMemo(() => readModuleConfig(document?.defaults ?? "{}"), [document?.defaults]);
	const saved = useMemo(() => parseModuleDraft(document?.content ?? "", defaults), [document?.content, defaults]);
	const parsed = useMemo(() => parseModuleDraft(draft, defaults), [draft, defaults]);
	const dirty = document !== undefined && draft !== document.content && (editor.sourceEdited
		|| saved.value === undefined || parsed.value === undefined || !equalConfigValues(saved.value, parsed.value));
	useSettingsDraft(id, {
		title, dirty, blocked: disabled, invalid: !!parsed.error,
		save: () => editor.save(draft, async (document, content) =>
			await send({ action: "saveModuleConfig", id, original: document.content, content }) ? { ...document, content } : undefined),
		discard: editor.discard,
	});
	if (!document) return <SettingsSection title={title}>
		{error ? <p role="alert">{error}</p> : <p role="status">读取中…</p>}
		{error && <Button variant="ghost" onClick={editor.reload}>重试</Button>}
	</SettingsSection>;
	const blocked = disabled || saving;
	const valueAt = (path: string) => at(parsed.value, path);
	const changeFields = (changes: Record<string, unknown>) => {
		let next = draft || "{}\n";
		for (const [path, value] of Object.entries(changes)) {
			next = applyEdits(next, modify(next, path.split("."), value, { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
		}
		editor.change(next);
	};
	const change = (path: string, value: unknown) => changeFields({ [path]: value });
	const sourceButton = <SettingsSourceButton key="source" file={document.path} source={source} disabled={blocked} onClick={() => { if (!dirty) editor.discard(); setSource(!source); }} />;
	const fields = (items: ConfigField[], fromSchema = false) => <div className="settings-fields">{items.map((field) => {
		if (field.type === "searchProviders") return <SearchProviderSettings key={field.path} path={field.path} choices={document.arrayOptions[field.path]}
			valueAt={valueAt} defaultAt={(path) => at(defaults, path)} change={change} changeGroups={changeFields} disabled={blocked}
			renderDetails={(prefix) => fields(Object.entries(document.fields)
				.filter(([path]) => path.startsWith(`${prefix}.`) && path !== `${prefix}.enabled`)
				.map(([path, schema]) => ({ path, label: schema.title ?? path.slice(prefix.length + 1) })), true)} />;
		const schema = fromSchema ? document.fields[field.path] : undefined;
		const configuredDefault = at(defaults, field.path);
		const defaultValue = configuredDefault === undefined ? schema?.default : configuredDefault;
		const configuredValue = valueAt(field.path);
		const value = configuredValue === undefined ? defaultValue : configuredValue;
		const locked = blocked || (field.enabledBy !== undefined && valueAt(field.enabledBy) !== true);
		let options = field.type === "profile"
			? [...new Set([defaults.profiles, parsed.overrides?.profiles].flatMap((profiles) =>
				typeof profiles === "object" && profiles !== null && !Array.isArray(profiles) ? Object.keys(profiles) : []))]
			: document.options[field.path];
		let displayValue = value;
		let controlDisabled = locked;
		if (field.type === "thinking") {
			const configuredModel = valueAt("model");
			const model = configuredModel === null ? currentModel : models.find((model) => `${model.provider}/${model.id}` === configuredModel);
			options = model?.thinking.levels ?? [];
			displayValue = typeof value === "string" ? model?.thinking.resolved[value] : undefined;
			controlDisabled ||= options.length === 0;
		}
		const control = <FieldControl field={field} schema={schema} options={options} value={displayValue} nullable={defaultValue === null} disabled={controlDisabled} models={models} tools={tools} change={(value) => change(field.path, value)} />;
		return <SettingsRow key={field.path} label={field.label}
			layout={Array.isArray(value) || schema?.type === "array" ? "wide" : field.type === "model" || (!options && (schema?.type === "string" || typeof value === "string" || value === null)) ? "fluid" : "inline"}
			reset={{ value, defaultValue, apply: () => change(field.path, undefined) }} disabled={locked}>
			{id === "webTools" && field.path.startsWith("websearch.") && field.path.endsWith(".api_key") && typeof value === "string"
				? <SearchApiKeyControl config={value} query={query}>{control}</SearchApiKeyControl> : control}
		</SettingsRow>;
	})}</div>;
	return <div className="settings-module">
		{source || parsed.error ? <SettingsSection key="main" title={title} actions={sourceButton} source={source}>
			{parsed.error && <p role="alert">{parsed.error}</p>}
			{source && <SourceEditor file={document.path} label={`${id} 全局 JSONC`} value={draft} disabled={blocked} onChange={editor.changeSource} />}
		</SettingsSection> : moduleGroups[id].map((group, index) => group.advanced
			? <SettingsDisclosure key={group.title} title={group.title}>{fields(group.fields)}</SettingsDisclosure>
			: <SettingsSection key={index === 0 ? "main" : group.title} title={group.title} actions={<>
				{index === 0 && sourceButton}
				{group.fields.filter((field) => field.type === "searchProviders").map((field) => {
					const paths = [field.path, field.path.replace(/primary_providers$/, "auxiliary_providers")];
					const changed = paths.some((path) => !equalConfigValues(valueAt(path), at(defaults, path)));
					return changed && <IconButton key={field.path} label={`重置${field.label}`} tooltip="恢复默认分组和顺序" size="icon-sm"
						disabled={blocked}
						onClick={() => changeFields(Object.fromEntries(paths.map((path) => [path, undefined])))}><RotateCcw /></IconButton>;
				})}
			</>}>
				{fields(group.fields)}
				{id === "approvalGate" && index === 0 && (valueAt("enabled") === false || valueAt("ui.non_interactive") === "allow")
					&& <p className="settings-warning">{valueAt("enabled") === false ? "权限审批已关闭。" : "非交互操作将直接放行。"}</p>}
				{id === "webTools" && group.title === "网页读取" && valueAt("webfetch.cookies.enabled") === true
					&& <p className="settings-warning">Cookie 可能包含登录凭据。</p>}
				{id === "discordPresence" && index === 0 && valueAt("enabled") === true && valueAt("profile") === "detailed"
					&& <p className="settings-warning">将向 Discord 展示项目名和文件名。</p>}
			</SettingsSection>)}
		{error && <p role="alert">{error}</p>}
	</div>;
}
