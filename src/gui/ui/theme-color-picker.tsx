import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { IconButton } from "./components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { applyThemeColor } from "./theme/apply.ts";
import { fromHsl, hex, toHex, toHsl, type Hsl } from "./theme/color.ts";
import "./theme-color-picker.css";

const presets = ["#8E8E93", "#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE", "#30B0C7", "#32ADE6", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55"];
type Props = { value: string; defaultValue: string; disabled: boolean; change: (color: string) => Promise<boolean> };

export function ThemeColorPicker(props: Props) {
	return <Popover><PopoverTrigger asChild>
		<Button variant="outline" className="theme-color-trigger" aria-label="主题色" disabled={props.disabled}>
			<span className="theme-color-swatch" style={{ background: props.value }} /><span>{props.value.toUpperCase()}</span><ChevronDown />
		</Button>
	</PopoverTrigger><PopoverContent className="theme-color-picker" align="end" aria-label="主题色调色板">
		<ThemeColorEditor {...props} />
	</PopoverContent></Popover>;
}

function ThemeColorEditor({ value, defaultValue, disabled, change }: Props) {
	const [hsl, setHsl] = useState<Hsl>(() => toHsl(hex(value)));
	const [draft, setDraft] = useState(value.toUpperCase());
	const saving = useRef(false);
	const color = toHex(fromHsl(hsl));
	useEffect(() => {
		setHsl((current) => toHex(fromHsl(current)) === value.toUpperCase() ? current : toHsl(hex(value)));
		setDraft(value.toUpperCase());
	}, [value]);
	useLayoutEffect(() => {
		applyThemeColor(color);
		return () => applyThemeColor(value);
	}, [color, value]);
	const preview = (next: Hsl) => { setHsl(next); setDraft(toHex(fromHsl(next))); };
	const save = async (next: string) => {
		if (disabled || saving.current || next === value.toUpperCase()) return;
		saving.current = true;
		try {
			if (!await change(next)) preview(toHsl(hex(value)));
		} finally { saving.current = false; }
	};
	const select = (next: string) => { preview(toHsl(hex(next))); void save(next); };
	const valid = /^#[\da-f]{6}$/i.test(draft);
	const commitHex = () => { if (valid) void save(draft.toUpperCase()); };
	const sliders = [
		{ index: 0, label: "色相", max: 360, unit: "°", background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" },
		{ index: 1, label: "饱和度", max: 100, unit: "%", background: `linear-gradient(to right, hsl(${hsl[0]} 0% ${hsl[2]}%), hsl(${hsl[0]} 100% ${hsl[2]}%))` },
		{ index: 2, label: "明度", max: 100, unit: "%", background: `linear-gradient(to right, #000, hsl(${hsl[0]} ${hsl[1]}% 50%), #fff)` },
	] as const;
	return <>
		<header><div><strong>主题色</strong><p>自动适配深浅色与文字对比度</p></div><span className="theme-color-swatch" style={{ background: color }} /></header>
		<div className="theme-color-presets" aria-label="预设主题色">{presets.map((preset) => <button key={preset} type="button" disabled={disabled}
			aria-label={`主题色 ${preset}`} aria-pressed={color === preset} onClick={() => select(preset)}>
			<span className="theme-color-swatch" style={{ background: preset }} />
		</button>)}</div>
		<div className="theme-color-custom"><strong>自定义</strong><IconButton label="恢复默认主题色" disabled={disabled || color === defaultValue.toUpperCase()}
			onClick={() => select(defaultValue.toUpperCase())}><RotateCcw /></IconButton></div>
		{sliders.map(({ index, label, max, unit, background }) => <label className="theme-color-slider" key={label}>
			<span>{label}<output>{Math.round(hsl[index])}{unit}</output></span>
			<input type="range" aria-label={label} min={0} max={max} step={1} value={hsl[index]} style={{ background }} disabled={disabled}
				onChange={(event) => {
					const next: [number, number, number] = [...hsl];
					next[index] = Number(event.target.value);
					preview(next);
				}} onPointerUp={() => void save(color)} onKeyUp={() => void save(color)} onBlur={() => void save(color)} />
		</label>)}
		<label className="theme-color-hex"><span>HEX</span><Input aria-label="主题色 HEX" value={draft} disabled={disabled} spellCheck={false}
			maxLength={7} aria-invalid={!valid} onChange={(event) => {
				const next = event.target.value;
				setDraft(next);
				if (/^#[\da-f]{6}$/i.test(next)) setHsl(toHsl(hex(next)));
			}} onBlur={commitHex} onKeyDown={(event) => {
				if (event.key === "Enter") { event.preventDefault(); commitHex(); }
			}} /></label>
		{!valid && <p role="alert">请输入 #RRGGBB 格式的颜色。</p>}
	</>;
}
