import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { GuiModel, GuiSnapshot, Query, GlobalQuery } from "../../contract.ts";
import type { ModuleConfigId } from "../../module-config.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { moduleGroups, type ConfigField } from "./module-fields.ts";
import { FieldControl } from "./field-control.tsx";
import { useConfigDraft } from "./use-config-draft.ts";
import { SettingsDisclosure, SettingsSection, SettingsRow, SettingsSourceButton } from "./settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "./settings-state.tsx";
import { SearchProviderSettings } from "./search-provider-settings.tsx";
import { SearchApiKeyControl } from "./search-api-key-control.tsx";

function readObject(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(text.replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true });
	if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("JSONC 必须是有效对象。");
	return value as Record<string, unknown>;
}
function at(value: unknown, path: string): unknown {
	for (const key of path.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function ModuleSettings({ title, id, query, send, disabled, models, tools }: {
	title: string; id: ModuleConfigId; query: Query<GlobalQuery>; send: Send; disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null;
}) {
	const editor = useConfigDraft(useCallback(() => query({ query: "moduleConfig", id }), [id, query]), String);
	const { document, draft, error } = editor;
	const dirty = document !== undefined && draft !== document.content;
	const { saving } = useSettingsState();
	const [source, setSource] = useState(false);
	let values: Record<string, unknown> = {};
	let parseError = "";
	try { values = readObject(draft); } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
	useSettingsDraft(id, {
		title, dirty, blocked: disabled, invalid: !!parseError,
		save: () => editor.save(draft, async (document, content) =>
			await send({ action: "saveModuleConfig", id, original: document.content, content }) ? { ...document, content } : undefined),
		discard: editor.discard,
	});
	if (!document) return <SettingsSection title={title}>
		{error ? <p role="alert">{error}</p> : <p role="status">读取中…</p>}
		{error && <Button variant="ghost" onClick={editor.reload}>重试</Button>}
	</SettingsSection>;
	const defaults = readObject(document.defaults);
	const blocked = disabled || saving;
	const valueAt = (path: string) => { const value = at(values, path); return value === undefined ? at(defaults, path) : value; };
	const changeFields = (changes: Record<string, unknown>) => {
		let next = draft || "{}\n";
		for (const [path, value] of Object.entries(changes)) {
			next = applyEdits(next, modify(next, path.split("."), value, { formattingOptions: { insertSpaces: false, tabSize: 4 } }));
		}
		editor.change(next);
	};
	const change = (path: string, value: unknown) => changeFields({ [path]: value });
	const sourceButton = <SettingsSourceButton file={document.path} source={source} disabled={blocked} onClick={() => setSource(!source)} />;
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
		const options = field.type === "profile"
			? [...new Set([defaults.profiles, values.profiles].flatMap((profiles) =>
				typeof profiles === "object" && profiles !== null && !Array.isArray(profiles) ? Object.keys(profiles) : []))]
			: document.options[field.path];
		const locked = blocked || (field.enabledBy !== undefined && valueAt(field.enabledBy) !== true);
		const control = <FieldControl field={field} schema={schema} options={options} value={value} nullable={defaultValue === null} disabled={locked} models={models} tools={tools} change={(value) => change(field.path, value)} />;
		return <SettingsRow key={field.path} label={field.label}
			layout={Array.isArray(value) || schema?.type === "array" ? "wide" : field.type === "model" || (!options && (schema?.type === "string" || typeof value === "string" || value === null)) ? "fluid" : "inline"}
			reset={{ value, defaultValue, apply: () => change(field.path, undefined) }} disabled={locked}>
			{id === "webTools" && field.path.startsWith("websearch.") && field.path.endsWith(".api_key") && typeof value === "string"
				? <SearchApiKeyControl config={value} query={query}>{control}</SearchApiKeyControl> : control}
		</SettingsRow>;
	})}</div>;
	return <div className="settings-module">
		{source || parseError ? <SettingsSection title={title} actions={sourceButton}>
			{parseError && <p role="alert">{parseError}</p>}
			{source && <Textarea aria-label={`${id} 全局 JSONC`} className="settings-source" value={draft} disabled={blocked} onChange={(event) => editor.change(event.target.value)} />}
		</SettingsSection> : moduleGroups[id].map((group, index) => group.advanced
			? <SettingsDisclosure key={group.title} title={group.title}>{fields(group.fields)}</SettingsDisclosure>
			: <SettingsSection key={group.title} title={group.title} actions={<>
				{index === 0 && sourceButton}
				{group.fields.filter((field) => field.type === "searchProviders").map((field) => {
					const paths = [field.path, field.path.replace(/primary_providers$/, "auxiliary_providers")];
					const changed = paths.some((path) => JSON.stringify(valueAt(path)) !== JSON.stringify(at(defaults, path)));
					return <IconButton key={field.path} label={`重置${field.label}`} tooltip="恢复默认分组和顺序" size="icon-sm"
						className={changed ? undefined : "invisible"} disabled={blocked || !changed}
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
