import { useCallback, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "@/ui/icon-button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { applyEdits, modify } from "jsonc-parser";
import { parseModuleDraft, readModuleConfig, configAt as at } from "./module-draft.ts";
import { compile } from "@earendil-works/pi-schema";
import { moduleConfigOptions } from "../../../shared/config/module-schema.ts";
import { equalConfigValues } from "../../../../harness/config-values.ts";
import type { GuiModel, GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Query, GlobalQuery } from "../../../shared/protocol/queries.ts";
import type { ModuleConfigId } from "../../../shared/config/modules.ts";
import type { ConfigCommand } from "@/connection/connection.ts";
import type { ModuleConfigDocument } from "../../../shared/config/modules.ts";
import { ConfigDocument } from "@/forms/config-document.tsx";
import { SourceEditor } from "@/forms/source-editor.tsx";
import { moduleGroups, type ConfigField } from "./module-fields.ts";
import { FieldControl } from "./field-control.tsx";
import { useTextConfigDraft } from "@/forms/use-text-config-draft.ts";
import { SettingsDisclosure, SettingsSection, SettingsRow, SettingsSourceButton } from "@/forms/settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "@/forms/drafts.tsx";
import { SearchProviderSettings } from "./search-provider-settings.tsx";
import { SearchApiKeyControl } from "./search-api-key-control.tsx";

interface Props {
	title: string; id: ModuleConfigId; query: Query<GlobalQuery>; send: ConfigCommand; disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; currentModel: GuiModel | null;
}
export function ModuleSettings({ query, ...props }: Props) {
	const load = useCallback(() => query({ query: "moduleConfig", id: props.id }), [props.id, query]);
	return <ConfigDocument title={props.title} load={load}>{(initial) => <ModuleEditor {...props} query={query} initial={initial} />}</ConfigDocument>;
}

function ModuleEditor({ initial, title, id, query, send, disabled, models, tools, currentModel }: Props & { initial: ModuleConfigDocument }) {
	const editor = useTextConfigDraft(initial);
	const { document, draft } = editor;
	const { saving } = useSettingsState();
	const [source, setSource] = useState(false);
	const defaults = useMemo(() => readModuleConfig(document.defaults), [document.defaults]);
	const validator = useMemo(() => compile(document.schema), [document.schema]);
	const metadata = useMemo(() => moduleConfigOptions(document.schema), [document.schema]);
	const saved = useMemo(() => parseModuleDraft(document.content, defaults, validator), [document.content, defaults, validator]);
	const parsed = useMemo(() => parseModuleDraft(draft, defaults, validator), [draft, defaults, validator]);
	const dirty = draft !== document.content && (editor.sourceEdited
		|| saved.value === undefined || parsed.value === undefined || !equalConfigValues(saved.value, parsed.value));
	useSettingsDraft(id, {
		title, blocked: disabled,
		plan: !dirty ? { state: "clean" } : parsed.error ? { state: "invalid" } : { state: "ready", save: () => editor.save(draft, async (document, content) => {
			await send({ action: "saveModuleConfig", id, original: document.content, content });
			return { ...document, content };
		}) },
		discard: editor.discard,
	});
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
	const sourceButton = <SettingsSourceButton key="source" file={document.path} source={source} disabled={blocked || source && parsed.error !== ""} onClick={() => { if (!dirty) editor.discard(); setSource(!source); }} />;
	const fields = (items: ConfigField[]) => <div className="settings-fields">{items.map((field) => {
		if (field.type === "searchProviders") return <SearchProviderSettings key={field.path} path={field.path} choices={metadata.arrayOptions[field.path]}
			valueAt={valueAt} defaultAt={(path) => at(defaults, path)} change={change} changeGroups={changeFields} disabled={blocked}
			renderDetails={(prefix) => fields(Object.entries(metadata.fields)
				.filter(([path]) => path.startsWith(`${prefix}.`) && path !== `${prefix}.enabled`)
				.map(([path, schema]) => ({ path, label: schema.title ?? path.slice(prefix.length + 1) })))} />;
		const schema = metadata.fields[field.path];
		if (!schema) throw new Error(`设置字段缺少 schema: ${field.path}`);
		const configuredDefault = at(defaults, field.path);
		const defaultValue = configuredDefault === undefined ? schema.default : configuredDefault;
		const configuredValue = valueAt(field.path);
		const value = configuredValue === undefined ? defaultValue : configuredValue;
		const locked = blocked || (field.enabledBy !== undefined && valueAt(field.enabledBy) !== true);
		let options = field.type === "profile"
			? [...new Set([defaults.profiles, parsed.overrides?.profiles].flatMap((profiles) =>
				typeof profiles === "object" && profiles !== null && !Array.isArray(profiles) ? Object.keys(profiles) : []))]
			: metadata.options[field.path];
		let displayValue = value;
		let controlDisabled = locked;
		if (field.type === "thinking") {
			const configuredModel = valueAt("model");
			const model = configuredModel === null ? currentModel : models.find((model) => `${model.provider}/${model.id}` === configuredModel);
			options = model?.thinking.levels ?? [];
			displayValue = typeof value === "string" ? model?.thinking.resolved[value] ?? "" : "";
			controlDisabled ||= options.length === 0;
		}
		const control = <FieldControl field={field} schema={schema} value={displayValue} options={options} disabled={controlDisabled} models={models} tools={tools} change={(value) => change(field.path, value)} />;
		return <SettingsRow key={field.path} label={field.label}
			layout={field.type === "radio" && options ? "choice" : schema.type === "array" ? "wide" : field.type === "model" || schema.type === "string" && !options ? "fluid" : "inline"}
			reset={{ value, defaultValue, apply: () => change(field.path, undefined) }} disabled={locked}>
			{id === "webTools" && field.path.startsWith("websearch.") && field.path.endsWith(".api_key") && typeof value === "string"
				? <SearchApiKeyControl config={value} query={query}>{control}</SearchApiKeyControl> : control}
		</SettingsRow>;
	})}</div>;
	return <div className="settings-module">
		{source || parsed.state === "invalid" || !dirty && parsed.error !== "" ? <SettingsSection key="main" title={title} actions={sourceButton} source={source}>
			<Feedback message={parsed.error} tone="error" />
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
				{index === 0 && <Feedback message={parsed.error} tone="error" />}
				{id === "approvalGate" && index === 0 && (valueAt("enabled") === false || valueAt("ui.non_interactive") === "allow")
					&& <p className="settings-warning">{valueAt("enabled") === false ? "权限审批已关闭。" : "非交互操作将直接放行。"}</p>}
				{id === "discordPresence" && index === 0 && valueAt("enabled") === true && valueAt("profile") === "detailed"
					&& <p className="settings-warning">将向 Discord 展示项目名和文件名。</p>}
			</SettingsSection>)}
	</div>;
}
