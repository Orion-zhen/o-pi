import { useCallback, useEffect, useState } from "react";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { GuiModel, GuiSnapshot, Query, GlobalQuery } from "../contract.ts";
import type { ModuleConfigId } from "../module-config.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { ModelSelect } from "./model-select.tsx";
import { moduleFields, type ConfigField } from "./module-fields.ts";
import { useConfigDraft } from "./config-draft.tsx";
import { SettingsActions, SettingsHeading, SettingsRow, SettingsSourceButton } from "./settings-controls.tsx";
import { SettingsListField } from "./settings-list-field.tsx";
import { SubagentToolPicker } from "./subagent-tool-picker.tsx";

function readObject(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(text.replace(/^\uFEFF/, "") || "{}", errors, { allowTrailingComma: true });
	if (errors.length || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("请先在 JSONC 中修复配置，根节点必须是对象。");
	return value as Record<string, unknown>;
}
function at(value: unknown, path: string): unknown {
	for (const key of path.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export function ModuleSettings({ title, id, query, send, disabled, onDirty, models, tools }: {
	title: string; id: ModuleConfigId; query: Query<GlobalQuery>; send: Send; disabled: boolean; onDirty: (id: ModuleConfigId, dirty: boolean) => void; models: GuiModel[]; tools: GuiSnapshot["tools"] | null;
}) {
	const editor = useConfigDraft(useCallback(() => query({ query: "moduleConfig", id }), [id, query]));
	const { document, draft, error, saving, dirty } = editor;
	const [source, setSource] = useState(false);
	useEffect(() => { onDirty(id, dirty); }, [id, dirty, onDirty]);
	useEffect(() => () => onDirty(id, false), [id, onDirty]);
	if (!document) return <div className="gui-settings"><SettingsHeading title={title} />
		{error ? <p role="alert">{error}</p> : <p role="status">正在读取配置…</p>}
		<div className="settings-action-buttons"><Button variant="ghost" onClick={editor.reload}>重新读取</Button></div>
	</div>;
	let values: Record<string, unknown> = {};
	let parseError = "";
	try { values = readObject(draft); } catch (error) { parseError = String(error); }
	const defaults = readObject(document.defaults);
	const blocked = disabled || saving;
	const change = (field: ConfigField, value: unknown) => {
		editor.change(applyEdits(draft || "{}\n", modify(draft || "{}\n", field.path.split("."), value, { formattingOptions: { insertSpaces: false, tabSize: 4 } })));
	};
	return <div className="gui-settings">
		<SettingsHeading title={title}>
			<SettingsSourceButton file={document.path} source={source} onClick={() => setSource(!source)} />
		</SettingsHeading>
		{id === "approvalGate" && <p className="settings-warning">关闭审批或允许非交互操作会减少安全限制。</p>}
		{id === "fileTools" && <p className="settings-warning">禁止访问列表应包含需要保护的凭据路径。</p>}
		{id === "webTools" && <p className="settings-warning">Cookie 可能携带登录凭据。选择 never 将不再逐次确认。</p>}
		{id === "discordPresence" && <p className="settings-warning">detailed 档案可能向 Discord 展示项目名和文件名。</p>}
		{source ? <Textarea aria-label={`${id} 全局 JSONC`} className="settings-source" value={draft} disabled={blocked} onChange={(event) => editor.change(event.target.value)} />
			: parseError ? <p role="alert">{parseError}</p> : <div className="settings-fields">
				{moduleFields[id].map((field) => {
					const override = at(values, field.path);
					const defaultValue = at(defaults, field.path);
					const value = override === undefined ? defaultValue : override;
					return <SettingsRow key={field.path} label={field.label} description={field.description}
						reset={{ value, defaultValue, apply: () => change(field, undefined) }} disabled={blocked}>
						<FieldControl field={field} value={value} nullable={defaultValue === null} disabled={blocked} models={models} tools={tools} change={(value) => change(field, value)} />
					</SettingsRow>;
				})}
			</div>}
		<SettingsActions {...editor} disabled={disabled} invalid={!!parseError} save={() => void editor.save(async (document, content) =>
			await send({ action: "saveModuleConfig", id, original: document.content, content }) ? { ...document, content } : undefined)} />
	</div>;
}

function NumberField({ label, value, disabled, change }: { label: string; value: number; disabled: boolean; change: (value: number) => void }) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	return <Input className="settings-number" aria-label={label} type="number" value={text} disabled={disabled} onChange={(event) => {
		setText(event.target.value);
		if (event.target.value && Number.isFinite(event.target.valueAsNumber)) change(event.target.valueAsNumber);
	}} onBlur={() => setText(String(value))} />;
}

function FieldControl({ field, value, nullable, disabled, models, tools, change }: { field: ConfigField; value: unknown; nullable: boolean; disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; change: (value: unknown) => void }) {
	if (typeof value === "boolean") return <Checkbox aria-label={field.label} checked={value} disabled={disabled} onCheckedChange={(value) => change(value === true)} />;
	if (field.type === "model") return <ModelSelect label={field.label} models={models} disabled={disabled}
		value={typeof value === "string" && value !== "" ? value : null} change={change} />;
	if (field.options) return <Select value={String(value)} disabled={disabled} onValueChange={change}>
		<SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{field.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
	</Select>;
	if (Array.isArray(value)) return field.type === "tools"
		? <SubagentToolPicker label={field.label} value={value} tools={tools} disabled={disabled} change={change} />
		: <SettingsListField label={field.label} value={value} disabled={disabled} change={change} />;
	if (typeof value === "number") return <NumberField label={field.label} value={value} disabled={disabled} change={change} />;
	return <Input aria-label={field.label} value={value === null ? "" : String(value)} disabled={disabled}
		onChange={(event) => change(event.target.value || (nullable ? null : ""))} />;
}
