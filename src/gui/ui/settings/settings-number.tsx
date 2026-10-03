import { useEffect, useState } from "react";
import { Input } from "../components/ui/input";

export function SettingsNumber({ label, value, disabled, change, min, max, step = "any", unit }: {
	label: string; value: number; disabled: boolean; change: (value: number) => void;
	min?: number; max?: number; step?: number | "any"; unit?: string;
}) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	return <div className="settings-number-control">
		<Input className="settings-number" aria-label={label} type="number" min={min} max={max} step={step} value={text} disabled={disabled}
			onChange={(event) => {
				setText(event.target.value);
				if (event.target.value && event.target.validity.valid) change(event.target.valueAsNumber);
			}} onBlur={() => setText(String(value))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
		{unit && <span>{unit}</span>}
	</div>;
}
