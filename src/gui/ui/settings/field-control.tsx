import type { GuiModel, GuiSnapshot } from "../../contract.ts";
import type { ModuleConfigField } from "../../module-config.ts";
import { Switch } from "../components/ui/switch";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ModelSelect } from "../models/model-select.tsx";
import { optionLabels, type ConfigField } from "./module-fields.ts";
import { SettingsListField } from "./settings-list-field.tsx";
import { SubagentToolPicker } from "./subagent-tool-picker.tsx";
import { SettingsNumber } from "./settings-number.tsx";

export function FieldControl({ field, schema, options, value, nullable, disabled, models, tools, change }: {
	field: ConfigField; schema: ModuleConfigField | undefined; options: readonly string[] | undefined; value: unknown; nullable: boolean;
	disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; change: (value: unknown) => void;
}) {
	if (schema?.type === "boolean" || typeof value === "boolean") return <Switch aria-label={field.label} checked={value === true} disabled={disabled} onCheckedChange={change} />;
	if (field.type === "model") return <ModelSelect label={field.label} models={models} disabled={disabled}
		value={typeof value === "string" && value !== "" ? value : null} change={change} />;
	if (options) return <Select value={value === undefined ? "" : String(value)} disabled={disabled} onValueChange={change}>
		<SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{optionLabels[option] ?? option}</SelectItem>)}</SelectContent>
	</Select>;
	if (Array.isArray(value) || schema?.type === "array") return field.type === "tools"
		? <SubagentToolPicker label={field.label} value={Array.isArray(value) ? value : []} tools={tools} disabled={disabled} change={change} />
		: <SettingsListField label={field.label} value={Array.isArray(value) ? value : []} disabled={disabled} change={change} />;
	if (typeof value === "number" || schema?.type === "number" || schema?.type === "integer") return <SettingsNumber label={field.label}
		value={typeof value === "number" ? value : undefined} disabled={disabled} min={schema?.minimum} max={schema?.maximum}
		step={schema?.type === "integer" ? 1 : "any"} change={change} />;
	return <Input aria-label={field.label} value={value === null || value === undefined ? "" : String(value)} disabled={disabled}
		minLength={schema?.minLength} maxLength={schema?.maxLength}
		onChange={(event) => change(event.target.value || (nullable ? null : ""))} />;
}
