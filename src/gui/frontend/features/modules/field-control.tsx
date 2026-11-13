import type { GuiModel, GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { ModuleConfigField } from "../../../shared/config/modules.ts";
import { Switch } from "@/ui/switch.tsx";
import { Input } from "@/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { Label } from "@/ui/label.tsx";
import { ModelSelect } from "@/features/models/model-select.tsx";
import type { ConfigField } from "./module-fields.ts";
import { SettingsListField } from "@/forms/list-field.tsx";
import { SubagentToolPicker } from "./subagent-tool-picker.tsx";
import { SettingsNumber } from "@/forms/number.tsx";

export function FieldControl({ field, schema, value, options, disabled, models, tools, change }: {
	field: ConfigField; schema: ModuleConfigField; value: unknown; options: readonly string[] | undefined;
	disabled: boolean; models: GuiModel[]; tools: GuiSnapshot["tools"] | null; change: (value: unknown) => void;
}) {
	if (field.type === "model" && (value === null || typeof value === "string"))
		return <ModelSelect label={field.label} models={models} disabled={disabled} value={value} change={change} />;
	if (options && typeof value === "string") return field.type === "radio"
		? <RadioGroup className="settings-radio-group" orientation="horizontal" aria-label={field.label} value={value} disabled={disabled} onValueChange={change}>
			{options.map((option) => <Label key={option} className="settings-radio-option"><RadioGroupItem value={option} />{field.optionLabels?.[option] ?? option}</Label>)}
		</RadioGroup>
		: <Select value={value} disabled={disabled} onValueChange={change}>
			<SelectTrigger aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
		</Select>;
	switch (schema.type) {
		case "boolean": if (typeof value === "boolean") return <Switch aria-label={field.label} checked={value} disabled={disabled} onCheckedChange={change} />; break;
		case "integer": case "number": if (typeof value === "number") return <SettingsNumber label={field.label} value={value} disabled={disabled}
			min={schema.minimum} max={schema.maximum} step={schema.type === "integer" ? 1 : "any"} change={change} />; break;
		case "array":
			if (Array.isArray(value) && value.every((item: unknown): item is string => typeof item === "string")) return field.type === "tools"
				? <SubagentToolPicker label={field.label} value={value} tools={tools} disabled={disabled} change={change} />
				: <SettingsListField label={field.label} value={value} disabled={disabled} change={change} />;
			break;
		case "string": if (typeof value === "string" || value === null && schema.nullable) return <Input aria-label={field.label} value={value ?? ""} disabled={disabled}
			minLength={schema.minLength} maxLength={schema.maxLength} onChange={(event) => change(event.target.value || (schema.nullable ? null : ""))} />; break;
	}
	throw new Error(`设置字段缺少有效的展示值: ${field.path}`);
}
