import { useId, useRef, useState } from "react";
import { useIsPresent } from "motion/react";
import { Pencil, Plus } from "lucide-react";
import { ChatTemplateKwargValueSchema, type ChatTemplateKwargValue } from "@earendil-works/pi-ai/providers/compat-schema";
import { equalConfigValues } from "../../../../../harness/config-values.ts";
import { Button } from "@/ui/button.tsx";
import { Checkbox } from "@/ui/checkbox.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { Switch } from "@/ui/switch.tsx";

const variables = ChatTemplateKwargValueSchema.anyOf.filter((schema) => schema.type === "object")
	.flatMap((schema) => schema.properties.$var.anyOf.map((option) => option.const));
const valueTypes = [...variables, ...ChatTemplateKwargValueSchema.anyOf.filter((schema) => schema.type !== "object").map((schema) => schema.type)];
type ValueType = typeof valueTypes[number];
export type TemplateValue = ChatTemplateKwargValue;
type Apply = (name: string, value: TemplateValue) => void;

function templateValueType(value: TemplateValue): ValueType {
	if (value === null) return "null";
	switch (typeof value) {
		case "string": return "string";
		case "number": return "number";
		case "boolean": return "boolean";
		case "object": return value.$var;
	}
}

function parseTemplateValue(kind: ValueType, text: string, boolean: boolean, omit: boolean): TemplateValue | undefined {
	switch (kind) {
		case "string": return text;
		case "boolean": return boolean;
		case "null": return null;
		case "number": {
			const value = Number(text);
			return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) && Number.isFinite(value) ? value : undefined;
		}
		default: return { $var: kind, ...(omit && { omitWhenOff: true }) };
	}
}

export function TemplateParamEditor({ idPrefix, name, value = "", inherited = false, existing, disabled, apply }: {
	idPrefix: string;
	name?: string;
	value?: TemplateValue;
	inherited?: boolean;
	existing: string[];
	disabled: boolean;
	apply: Apply;
}) {
	const [open, setOpen] = useState(false);
	const present = useIsPresent();
	const renamed = useRef<string | undefined>(undefined);
	const title = name === undefined ? "添加参数" : `编辑参数 ${name}`;
	return <Popover modal open={open && present} onOpenChange={setOpen}>
		<PopoverTrigger asChild>{name === undefined
			? <Button type="button" size="sm" variant="outline" aria-label={title} disabled={disabled}><Plus />{title}</Button>
			: <IconButton id={`${idPrefix}-${name}`} size="icon-sm" label={title} tooltip="编辑参数" disabled={disabled}><Pencil /></IconButton>}
		</PopoverTrigger>
		<PopoverContent className="service-template-editor" aria-label={title} onCloseAutoFocus={(event) => {
			if (renamed.current === undefined) return;
			event.preventDefault();
			document.getElementById(`${idPrefix}-${renamed.current}`)?.focus();
		}}>
			<TemplateParamForm name={name} value={value} inherited={inherited} existing={existing} disabled={disabled}
				cancel={() => setOpen(false)} apply={(nextName, nextValue) => {
					if (name !== undefined && nextName !== name) renamed.current = nextName;
					if (nextName !== name || !equalConfigValues(value, nextValue)) apply(nextName, nextValue);
					setOpen(false);
				}} />
		</PopoverContent>
	</Popover>;
}

function TemplateParamForm({ name, value, inherited, existing, disabled, apply, cancel }: {
	name: string | undefined;
	value: TemplateValue;
	inherited: boolean;
	existing: string[];
	disabled: boolean;
	apply: Apply;
	cancel: () => void;
}) {
	const id = useId();
	const [nextName, setName] = useState(name ?? "");
	const [kind, setKind] = useState<ValueType>(templateValueType(value));
	const [text, setText] = useState(typeof value === "string" || typeof value === "number" ? String(value) : "");
	const [boolean, setBoolean] = useState(value === true);
	const [omit, setOmit] = useState(typeof value === "object" && value !== null && value.omitWhenOff === true);
	const variable = variables.find((variable) => variable === kind);
	const duplicate = nextName !== name && existing.includes(nextName);
	const nextValue = parseTemplateValue(kind, text, boolean, omit);
	const invalidNumber = kind === "number" && nextValue === undefined;
	const valid = nextName.trim() !== "" && !duplicate && nextValue !== undefined;

	return <form className="service-template-param-form" onSubmit={(event) => {
		event.preventDefault();
		if (!valid || disabled) return;
		apply(nextName, nextValue);
	}}>
		<label htmlFor={`${id}-name`}>参数名</label>
		<Input id={`${id}-name`} value={nextName} readOnly={inherited} disabled={disabled} aria-invalid={duplicate}
			aria-describedby={duplicate ? `${id}-duplicate` : undefined} autoComplete="off" spellCheck={false}
			onChange={(event) => setName(event.target.value)} />
		{duplicate && <p id={`${id}-duplicate`} role="alert">参数名已存在</p>}
		<label htmlFor={`${id}-type`}>取值类型</label>
		<Select value={kind} disabled={disabled} onValueChange={(next) => {
			const selected = valueTypes.find((type) => type === next);
			if (selected) setKind(selected);
		}}>
			<SelectTrigger id={`${id}-type`} aria-label="取值类型"><SelectValue /></SelectTrigger>
			<SelectContent>{valueTypes.map((type) => <SelectItem key={type} value={type}><code>{type}</code></SelectItem>)}</SelectContent>
		</Select>
		{(kind === "string" || kind === "number") && <>
			<label htmlFor={`${id}-value`}>值</label>
			<Input id={`${id}-value`} value={text} inputMode={kind === "number" ? "decimal" : undefined} disabled={disabled}
				aria-invalid={invalidNumber} aria-describedby={invalidNumber ? `${id}-number` : undefined} autoComplete="off" spellCheck={false}
				onChange={(event) => setText(event.target.value)} />
			{invalidNumber && <p id={`${id}-number`} role="alert">请输入有效的有限数字</p>}
		</>}
		{kind === "boolean" && <div className="service-template-option">
			<Switch id={`${id}-boolean`} aria-label="值" checked={boolean} disabled={disabled} onCheckedChange={setBoolean} />
			<label htmlFor={`${id}-boolean`}><code>{String(boolean)}</code></label>
		</div>}
		{variable && <div className="service-template-option">
			<Checkbox id={`${id}-omit`} checked={omit} disabled={disabled} onCheckedChange={(checked) => setOmit(checked === true)} />
			<label htmlFor={`${id}-omit`}><code>omitWhenOff</code></label>
		</div>}
		<div className="settings-action-buttons">
			<Button type="submit" size="sm" disabled={disabled || !valid}>{name === undefined ? "添加" : "应用"}</Button>
			<Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={cancel}>取消</Button>
		</div>
	</form>;
}
