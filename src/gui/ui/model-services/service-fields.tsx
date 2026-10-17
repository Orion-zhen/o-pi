import { useId, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { SettingsRow } from "../settings/settings-controls.tsx";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { OpenAICompletionsCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { THINKING_PRESETS } from "../../../harness/openai-compatible-provider/schema.ts";

export const textValue = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
export const apiChoices = [["openai-completions", "Chat Completions"], ["openai-responses", "Responses"]] as const;
const inherit = "@default";
export const thinkingChoices = MODEL_THINKING_LEVELS.map((key) => [key, key] as const);
export const presetChoices = THINKING_PRESETS.map((key) => [key, key] as const);
export const formatChoices = OpenAICompletionsCompatSchema.properties.thinkingFormat.anyOf.map(({ const: key }) => [key, key] as const);

type FieldProps<T> = { label: string; value: unknown; change: (value: T | undefined) => void; disabled: boolean };
export function ServiceText({ label, value, change, disabled, required = false, numeric = false, placeholder }: FieldProps<string | number> & {
	required?: boolean; numeric?: boolean; placeholder?: string;
}) {
	const id = useId();
	return <SettingsRow label={label} htmlFor={id} layout="fluid" disabled={disabled}
		{...(!required && { reset: { value, defaultValue: undefined, apply: () => change(undefined) } })}>
		<Input id={id} aria-label={label} disabled={disabled} value={textValue(value)}
			type="text" autoComplete="off" spellCheck={false} inputMode={numeric ? "decimal" : undefined} placeholder={placeholder}
			onChange={(event) => {
				const text = event.target.value;
				if (text === "") change(required ? "" : undefined);
				else if (numeric && /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))) change(Number(text));
				else change(text);
			}} />
	</SettingsRow>;
}
export function ServiceChoice({ label, value, change, disabled, options, required = false, defaultLabel = "默认" }: FieldProps<string> & {
	options: readonly (readonly [string, ReactNode])[]; required?: boolean; defaultLabel?: string;
}) {
	const current = value === undefined ? inherit : String(value);
	const choices = required ? options : [[inherit, defaultLabel] as const, ...options];
	return <SettingsRow label={label} layout="fluid">
		<Select value={current} disabled={disabled} onValueChange={(next) => change(next === inherit ? undefined : next)}>
			<SelectTrigger aria-label={label}><SelectValue>{choices.find(([key]) => key === current)?.[1] ?? current}</SelectValue></SelectTrigger>
			<SelectContent>{choices.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</SelectContent>
		</Select>
	</SettingsRow>;
}
export function ServiceBoolean(props: FieldProps<boolean>) {
	return <ServiceChoice {...props} options={[["true", "开启"], ["false", "关闭"]]} change={(value) => props.change(value === undefined ? undefined : value === "true")} />;
}
export function AddServiceItem({ label, existing, disabled, add, cancel }: {
	label: string; existing: string[]; disabled: boolean; add: (id: string) => void; cancel: () => void;
}) {
	const [id, setId] = useState("");
	const duplicate = existing.includes(id.trim());
	return <form className="service-add" onSubmit={(event) => { event.preventDefault(); if (id.trim() && !duplicate && !disabled) add(id.trim()); }}>
		<Input autoFocus aria-label={label} placeholder={label} value={id} disabled={disabled} onChange={(event) => setId(event.target.value)} aria-invalid={duplicate} />
		<div className="settings-action-buttons"><Button size="sm" type="submit" disabled={disabled || !id.trim() || duplicate}><Plus />添加</Button><Button size="sm" variant="ghost" type="button" onClick={cancel}>取消</Button></div>
		{duplicate && <p role="alert">{label}已存在</p>}
	</form>;
}
