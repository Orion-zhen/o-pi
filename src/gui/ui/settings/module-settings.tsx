import { useCallback, useState } from "react";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { GuiModel, GuiSnapshot, Query, GlobalQuery } from "../../contract.ts";
import type { ModuleConfigId } from "../../module-config.ts";
import type { Send } from "../runtime/connection.ts";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ModelSelect } from "../models/model-select.tsx";
import { moduleGroups, optionLabels, type ConfigField } from "./module-fields.ts";
import { useConfigDraft } from "./use-config-draft.ts";
import { SettingsDisclosure, SettingsSection, SettingsRow, SettingsSourceButton } from "./settings-controls.tsx";
import { useSettingsDraft, useSettingsState } from "./settings-state.tsx";
import { SettingsListField } from "./settings-list-field.tsx";
import { SubagentToolPicker } from "./subagent-tool-picker.tsx";
import { SettingsNumber } from "./settings-number.tsx";

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
	const change = (field: ConfigField, value: unknown) => {
		editor.change(applyEdits(draft || "{}\n", modify(draft || "{}\n", field.path.split("."), value, { formattingOptions: { insertSpaces: false, tabSize: 4 } })));
	};
	const sourceButton = <SettingsSourceButton file={document.path} source={source} disabled={blocked} onClick={() => setSource(!source)} />;
	const fields = (items: ConfigField[]) => <div className="settings-fields">{items.map((field) => {
		const value = valueAt(field.path);
		const defaultValue = at(defaults, field.path);
		const options = field.type === "profile"
			? [...new Set([defaults.profiles, values.profiles].flatMap((profiles) =>
				typeof profiles === "object" && profiles !== null && !Array.isArray(profiles) ? Object.keys(profiles) : []))]
			: document.options[field.path];
		const locked = blocked || (field.enabledBy !== undefined && valueAt(field.enabledBy) !== true);
		return <SettingsRow key={field.path} label={field.label}
			layout={Array.isArray(value) ? "wide" : field.type === "model" || (!options && (typeof value === "string" || value === null)) ? "fluid" : "inline"}
			reset={{ value, defaultValue, apply: () => change(field, undefined) }} disabled={locked}>
			<FieldControl field={field} options={options} value={value} nullable={defaultValue === null} disabled={locked} models={models} tools={tools} change={(value) => change(field, value)} />
		</SettingsRow>;
	})}</div>;
	return <div className="settings-module">
		{source || parseError ? <SettingsSection title={title} actions={sourceButton}>
			{parseError && <p role="alert">{parseError}</p>}
			{source && <Textarea aria-label={`${id} 全局 JSONC`} className="settings-source" value={draft} disabled={blocked} onChange={(event) => editor.change(event.target.value)} />}
		</SettingsSection> : moduleGroups[id].map((group, index) => group.advanced
			? <SettingsDisclosure key={group.title} title={group.title}>{fields(group.fields)}</SettingsDisclosure>
			: <SettingsSection key={group.title} title={group.title} actions={index === 0 ? sourceButton : undefined}>
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

function FieldControl({ field, options, value, nullable, disabled, models, tools, change }: { field: ConfigField; options: readonly string[] | undefined; value: unknown; nullable: boolean; disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; change: (value: unknown) => void }) {
	if (typeof value === "boolean") return <Switch aria-label={field.label} checked={value} disabled={disabled} onCheckedChange={change} />;
	if (field.type === "model") return <ModelSelect label={field.label} models={models} disabled={disabled}
		value={typeof value === "string" && value !== "" ? value : null} change={change} />;
	if (options) return <Select value={String(value)} disabled={disabled} onValueChange={change}>
		<SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{optionLabels[option] ?? option}</SelectItem>)}</SelectContent>
	</Select>;
	if (Array.isArray(value)) return field.type === "tools"
		? <SubagentToolPicker label={field.label} value={value} tools={tools} disabled={disabled} change={change} />
		: <SettingsListField label={field.label} value={value} disabled={disabled} change={change} />;
	if (typeof value === "number") return <SettingsNumber label={field.label} value={value} disabled={disabled} change={change} />;
	return <Input aria-label={field.label} value={value === null ? "" : String(value)} disabled={disabled}
		onChange={(event) => change(event.target.value || (nullable ? null : ""))} />;
}
