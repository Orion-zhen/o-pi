import { useEffect, useState } from "react";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { GuiModel, Query } from "../contract.ts";
import type { ModuleConfigDocument, ModuleConfigId } from "../module-config.ts";
import type { Send } from "./connection.ts";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { RotateCcw } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { ModelSelect } from "./model-select.tsx";
import { moduleFields, type ConfigField } from "./module-fields.ts";

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

export function ModuleSettings({ id, query, send, disabled, onDirty, models }: {
	id: ModuleConfigId; query: Query; send: Send; disabled: boolean; onDirty: (id: ModuleConfigId, dirty: boolean) => void; models: GuiModel[];
}) {
	const [document, setDocument] = useState<ModuleConfigDocument>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [saving, setSaving] = useState(false);
	const [source, setSource] = useState(false);
	const [revision, setRevision] = useState(0);
	const dirty = document !== undefined && draft !== document.content;
	useEffect(() => { onDirty(id, dirty); }, [id, dirty, onDirty]);
	useEffect(() => {
		let active = true;
		setDocument(undefined);
		setError("");
		void query({ query: "moduleConfig", id }).then((result) => {
			if (active) { setDocument(result); setDraft(result.content); }
		}, (error: unknown) => { if (active) setError(String(error)); });
		return () => { active = false; };
	}, [id, query, revision]);
	if (!document) return <div>{error ? <p role="alert">{error}</p> : <p role="status">正在读取配置…</p>}<Button variant="outline" onClick={() => setRevision(revision + 1)}>重新读取</Button></div>;
	let values: Record<string, unknown> = {};
	let parseError = "";
	try { values = readObject(draft); } catch (error) { parseError = String(error); }
	const defaults = readObject(document.defaults);
	const blocked = disabled || saving;
	const change = (field: ConfigField, value: unknown) => {
		setDraft(applyEdits(draft || "{}\n", modify(draft || "{}\n", field.path.split("."), value, { formattingOptions: { insertSpaces: false, tabSize: 4 } })));
		setStatus("");
	};
	const save = async () => {
		setSaving(true); setError(""); setStatus("");
		try {
			if (await send({ action: "saveModuleConfig", id, original: document.content, content: draft })) {
				setDocument({ ...document, content: draft });
				setStatus("已保存");
			} else setError("保存失败，请查看错误通知。草稿已保留。");
		} catch (error) { setError(String(error)); }
		finally { setSaving(false); }
	};
	return <div className="gui-settings module-settings">
		{id === "approvalGate" && <p className="settings-warning">关闭审批或允许非交互操作会减少安全限制。</p>}
		{id === "fileTools" && <p className="settings-warning">禁止访问列表应包含需要保护的凭据路径。</p>}
		{id === "webTools" && <p className="settings-warning">Cookie 可能携带登录凭据。选择 never 将不再逐次确认。</p>}
		{id === "discordPresence" && <p className="settings-warning">detailed 档案可能向 Discord 展示项目名和文件名。</p>}
		<div className="toolbar"><Button variant="outline" onClick={() => setSource(!source)}>{source ? "返回表单" : "编辑 JSONC"}</Button></div>
		{source ? <Textarea aria-label={`${id} 全局 JSONC`} className="module-source" value={draft} disabled={blocked} onChange={(event) => { setDraft(event.target.value); setStatus(""); }} />
			: parseError ? <p role="alert">{parseError}</p> : <>
				{moduleFields[id].map((field) => {
					const override = at(values, field.path);
					const value = override === undefined ? at(defaults, field.path) : override;
					return <div className="module-field" key={field.path}>
						<div className="preference-row"><span>{field.label}</span>
							<FieldControl field={field} value={value} nullable={at(defaults, field.path) === null} disabled={blocked} models={models} change={(value) => change(field, value)} />
							<IconButton label={`重置${field.label}`} disabled={blocked || override === undefined} onClick={() => change(field, undefined)}><RotateCcw /></IconButton>
						</div>
					</div>;
				})}
			</>}
		{error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
		<div className="toolbar module-actions">
			<Button disabled={blocked || !dirty || !!parseError} onClick={() => void save()}>保存</Button>
			<Button variant="outline" disabled={blocked || !dirty} onClick={() => { setDraft(document.content); setError(""); setStatus(""); }}>放弃修改</Button>
			<Button variant="ghost" disabled={blocked || dirty} onClick={() => setRevision(revision + 1)}>重新读取</Button>
			{dirty && <span role="status">有未保存修改</span>}
		</div>
	</div>;
}

function NumberField({ label, value, disabled, change }: { label: string; value: number; disabled: boolean; change: (value: number) => void }) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	return <Input aria-label={label} type="number" value={text} disabled={disabled} onChange={(event) => {
		setText(event.target.value);
		if (event.target.value && Number.isFinite(event.target.valueAsNumber)) change(event.target.valueAsNumber);
	}} onBlur={() => setText(String(value))} />;
}

function FieldControl({ field, value, nullable, disabled, models, change }: { field: ConfigField; value: unknown; nullable: boolean; disabled: boolean; models: GuiModel[]; change: (value: unknown) => void }) {
	if (typeof value === "boolean") return <Checkbox aria-label={field.label} checked={value} disabled={disabled} onCheckedChange={(value) => change(value === true)} />;
	if (field.type === "model") return <ModelSelect label={field.label} models={models} disabled={disabled}
		value={typeof value === "string" && value !== "" ? value : null} change={change} />;
	if (field.options) return <Select value={String(value)} disabled={disabled} onValueChange={change}>
		<SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{field.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
	</Select>;
	if (Array.isArray(value)) return <Textarea aria-label={field.label} value={value.join("\n")} disabled={disabled} onChange={(event) => change(event.target.value === "" ? [] : event.target.value.split("\n"))} onBlur={(event) => {
		const lines = event.target.value.split("\n").map((line) => line.trim()).filter(Boolean);
		if (JSON.stringify(lines) !== JSON.stringify(value)) change(lines);
	}} />;
	if (typeof value === "number") return <NumberField label={field.label} value={value} disabled={disabled} change={change} />;
	return <Input aria-label={field.label} value={value === null ? "" : String(value)} disabled={disabled}
		onChange={(event) => change(event.target.value || (nullable ? null : ""))} />;
}
