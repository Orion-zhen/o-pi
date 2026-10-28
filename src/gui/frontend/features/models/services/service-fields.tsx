import { createContext, useContext, useId, type ReactNode } from "react";
import { MODEL_INPUT_MODALITIES, type ModelInputModality } from "@earendil-works/pi-ai/providers/model-schema";
import { Input } from "@/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { Label } from "@/ui/label.tsx";
import { Switch } from "@/ui/switch.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group.tsx";
import { SettingsRow } from "@/forms/settings-controls.tsx";

export const textValue = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
export const ModelApiChoicesContext = createContext<readonly string[]>([]);
const unset = "@unset";

type FieldProps<T> = {
	label: string;
	value: unknown;
	defaultValue?: unknown;
	change: (value: T | undefined) => void;
	disabled: boolean;
};
type TextProps = { required?: boolean; placeholder?: string; inputMode?: "decimal" };
type AvailabilityProps = { unavailable?: string | undefined; hint?: string | undefined };

// 离散选项选回默认值时恢复继承。文本保留输入值，避免截断数字和名称的编辑中间态。
function inheritedValue<T>(value: T, defaults: unknown): T | undefined {
	return JSON.stringify(value) === JSON.stringify(defaults) ? undefined : value;
}

export function ServiceText({ label, value, change, disabled, required = false, placeholder, defaultValue, inputMode }: FieldProps<string> & TextProps) {
	const id = useId();
	return <SettingsRow label={label} htmlFor={id} layout="fluid" disabled={disabled}
		{...(!required && { reset: { value: value ?? defaultValue, defaultValue, apply: () => change(undefined) } })}>
		<Input id={id} aria-label={label} disabled={disabled} value={textValue(value)}
			type="text" autoComplete="off" spellCheck={false} inputMode={inputMode} placeholder={placeholder}
			onChange={(event) => change(event.target.value === "" && !required ? undefined : event.target.value)} />
	</SettingsRow>;
}

export function ServiceApi({ value, defaultValue, change, disabled, label = "API 协议" }: FieldProps<string>) {
	const apis = useContext(ModelApiChoicesContext);
	return <ServiceChoice label={label} value={value} defaultValue={defaultValue} disabled={disabled} required
		options={apis.map((api) => [api, api])} placeholder="选择 API 协议" change={change} />;
}

export function ServiceNumber({ change, ...props }: FieldProps<string | number> & { placeholder?: string }) {
	return <ServiceText {...props} inputMode="decimal" change={(text) => {
		const numeric = text !== undefined && /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text));
		change(numeric ? Number(text) : text);
	}} />;
}

export function ServiceChoice({ label, value, change, disabled, options, radio = false, required = false, defaultValue, unsetLabel, placeholder, unavailable, hint }: FieldProps<string> & AvailabilityProps & {
	options: readonly (readonly [string, ReactNode, boolean?])[];
	radio?: boolean;
	required?: boolean;
	unsetLabel?: string;
	placeholder?: string;
}) {
	const id = useId();
	const description = unavailable ?? hint;
	const effective = value ?? defaultValue;
	const current = effective === undefined ? unsetLabel ? unset : "" : String(effective);
	const choices = unsetLabel && defaultValue === undefined ? [[unset, unsetLabel] as const, ...options] : options;
	const select = (next: string) => {
		if (next === unset) change(undefined);
		else change(required ? next : inheritedValue(next, defaultValue));
	};
	return <SettingsRow label={label} layout={radio ? "choice" : "fluid"} disabled={disabled}
		description={description && <span id={id}>{description}</span>}
		{...(!required && { reset: { value: effective, defaultValue, apply: () => change(undefined) } })}>
		{radio ? <RadioGroup className="settings-radio-group" orientation="horizontal" aria-label={label} aria-describedby={description ? id : undefined}
			value={current} disabled={disabled || Boolean(unavailable)} onValueChange={select}>
			{choices.map(([key, title, unavailable]) => <Label key={key} className="settings-radio-option"><RadioGroupItem value={key} disabled={unavailable} />{title}</Label>)}
		</RadioGroup> : <Select value={current} disabled={disabled || Boolean(unavailable)} onValueChange={select}>
			<SelectTrigger aria-label={label} aria-describedby={description ? id : undefined}>
				<SelectValue placeholder={placeholder}>{choices.find(([key]) => key === current)?.[1] ?? (current || undefined)}</SelectValue>
			</SelectTrigger>
			<SelectContent>{choices.map(([key, title, unavailable]) => <SelectItem key={key} value={key} disabled={unavailable}>{title}</SelectItem>)}</SelectContent>
		</Select>}
	</SettingsRow>;
}

const inputLabels: Record<ModelInputModality, string> = { text: "文本", image: "图片" };
const inputModalities = (value: unknown) => MODEL_INPUT_MODALITIES.filter((modality) => Array.isArray(value) && value.includes(modality));

export function ServiceInput({ label, value, defaultValue, disabled, change }: FieldProps<ModelInputModality[]>) {
	const selected = inputModalities(value ?? defaultValue);
	const defaults = inputModalities(defaultValue);
	return <SettingsRow label={label} layout="fluid" disabled={disabled}
		reset={{ value: selected, defaultValue: defaults, apply: () => change(undefined) }}>
		<ToggleGroup type="multiple" variant="outline" className="gap-[var(--space-2)]" aria-label={label}
			value={selected} disabled={disabled} onValueChange={(value) => change(inheritedValue(inputModalities(value), defaults))}>
			{MODEL_INPUT_MODALITIES.map((modality) => <ToggleGroupItem key={modality} value={modality}
				className="min-w-0 flex-1 font-normal" aria-label={inputLabels[modality]}>
				{inputLabels[modality]}
			</ToggleGroupItem>)}
		</ToggleGroup>
	</SettingsRow>;
}

export function ServiceBoolean({ label, value, defaultValue, placeholder, disabled, change, unavailable, hint }: FieldProps<boolean> & AvailabilityProps & { placeholder?: string }) {
	const id = useId();
	const effective = value ?? defaultValue;
	const description = unavailable ?? hint ?? (effective === undefined ? placeholder : undefined);
	return <SettingsRow label={label} htmlFor={id} disabled={disabled}
		description={description && <span id={`${id}-hint`}>{description}</span>}
		reset={{ value: effective, defaultValue, apply: () => change(undefined) }}>
		<Switch id={id} aria-label={label} aria-describedby={description ? `${id}-hint` : undefined}
			checked={effective === true} disabled={disabled || Boolean(unavailable)} onCheckedChange={(next) => change(inheritedValue(next, defaultValue))} />
	</SettingsRow>;
}
