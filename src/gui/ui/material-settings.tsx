import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { materialRegions, type GuiMaterials, type GuiPreferences, type MaterialRegion, type MaterialSurface } from "../preferences.ts";
import { previewMaterials } from "./theme/materials.ts";
import { IconButton } from "./components/icon-button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { SettingsRow } from "./settings-controls.tsx";
import "./material-settings.css";

export type MaterialPreferencePath = ["materials", "enabled" | "desktop"] | ["materials", MaterialRegion, keyof MaterialSurface];
const regions = {
	canvas: { label: "内容画布", surface: "--canvas", filter: "--canvas-filter" },
	sidebar: { label: "左侧栏", surface: "--glass", filter: "--sidebar-filter" },
	toolbar: { label: "顶栏", surface: "--toolbar", filter: "--toolbar-filter" },
	inspector: { label: "会话信息栏", surface: "--inspector", filter: "--inspector-filter" },
	composer: { label: "输入器", surface: "--composer", filter: "--composer-filter" },
	floating: { label: "菜单与浮层", surface: "--popover", filter: "--glass-filter" },
	dialog: { label: "弹窗", surface: "--dialog", filter: "--dialog-filter" },
	overlay: { label: "弹窗遮罩", surface: "--overlay", filter: "--overlay-filter" },
} satisfies Record<MaterialRegion, { label: string; surface: string; filter: string }>;

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
function subscribeTheme(change: () => void): () => void {
	darkScheme.addEventListener("change", change);
	return () => darkScheme.removeEventListener("change", change);
}
const systemDark = () => darkScheme.matches;
const noSubscription = () => () => {};

export function MaterialSettings({ value, defaults, theme, disabled, change, reset }: {
	value: GuiMaterials; defaults: GuiMaterials; theme: GuiPreferences["theme"]; disabled: boolean;
	change: (path: MaterialPreferencePath, value: number | boolean | undefined) => void;
	reset: (region: MaterialRegion, keys: readonly (keyof MaterialSurface)[]) => void;
}) {
	const prefersDark = useSyncExternalStore(theme === "system" ? subscribeTheme : noSubscription, systemDark);
	const dark = theme === "dark" || (theme === "system" && prefersDark);
	const opacityKey = dark ? "darkOpacity" : "opacity";
	const parameters = [
		{ key: opacityKey, label: "不透明度", unit: "%", max: 100 },
		{ key: "blur", label: "模糊", unit: "px", max: 64 },
		{ key: "saturation", label: "饱和度", unit: "%", max: 200 },
	] as const;
	const [hovered, setHovered] = useState<MaterialRegion>();
	const [focused, setFocused] = useState<MaterialRegion>();
	const active = focused ?? hovered;
	const blocked = disabled || !value.enabled;
	useLayoutEffect(() => previewMaterials(value), [value]);
	return <section className="material-settings" aria-label="磨砂与透明">
		<h3>磨砂与透明</h3>
		<SettingsRow label="启用磨砂材质" disabled={disabled} reset={{ value: value.enabled, defaultValue: defaults.enabled, apply: () => change(["materials", "enabled"], undefined) }}>
			<Checkbox aria-label="启用磨砂材质" checked={value.enabled} disabled={disabled} onCheckedChange={(checked) => change(["materials", "enabled"], checked === true)} />
		</SettingsRow>
		<SettingsRow label="桌面背景透明" disabled={disabled} reset={{ value: value.desktop, defaultValue: defaults.desktop, apply: () => change(["materials", "desktop"], undefined) }}>
			<Checkbox aria-label="桌面背景透明" checked={value.desktop} disabled={blocked} onCheckedChange={(checked) => change(["materials", "desktop"], checked === true)} />
			<span className="material-save-hint">保存后生效</span>
		</SettingsRow>
		<MaterialPreview active={active} />
		<table className="material-table" aria-label="材质区域设置">
			<thead><tr><th scope="col">区域</th>{parameters.map(({ label }) => <th key={label} scope="col">{label}</th>)}</tr></thead>
			{[materialRegions.slice(0, 5), materialRegions.slice(5)].map((group, index) => <tbody key={index}>
				{group.map((region) => <tr key={region} data-active={active === region}
					onPointerEnter={() => setHovered(region)} onPointerLeave={() => setHovered(undefined)}
					onFocusCapture={() => setFocused(region)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
					<th scope="row"><div className="material-region-label">{regions[region].label}
						<IconButton size="icon-sm" label={`重置${regions[region].label}材质`} disabled={blocked || parameters.every(({ key }) => value[region][key] === defaults[region][key])}
							onClick={() => reset(region, parameters.map(({ key }) => key))}><RotateCcw /></IconButton>
					</div></th>
					{parameters.map(({ key, label, unit, max }) => <td key={key} data-label={label}>
						<MaterialNumber label={`${regions[region].label}${label}`} value={value[region][key]} unit={unit} max={max} disabled={blocked}
							change={(next) => change(["materials", region, key], next === defaults[region][key] ? undefined : next)} />
					</td>)}
				</tr>)}
			</tbody>)}
		</table>
	</section>;
}

function MaterialPreview({ active }: { active: MaterialRegion | undefined }) {
	const surface = (region: MaterialRegion, children?: ReactNode) => <div className={`material-preview-surface material-preview-${region}`} data-active={active === region}
		style={{ background: `var(${regions[region].surface})`, backdropFilter: `var(${regions[region].filter})` }}>
		<span>{regions[region].label}</span>{children}
	</div>;
	return <div className="material-preview" role="img" aria-label={`界面材质预览${active ? `：${regions[active].label}` : ""}`}>
		<div className="material-preview-window" aria-hidden="true">
			{surface("sidebar", <div className="material-preview-lines"><i /><i /><i /></div>)}
			{surface("toolbar")}
			{surface("canvas", <><div className="material-preview-message">你好，有什么可以帮你？</div>{surface("composer")}</>)}
			{surface("inspector", <div className="material-preview-lines"><i /><i /></div>)}
			{active === "floating" && surface("floating", <div className="material-preview-lines"><i /><i /></div>)}
			{(active === "dialog" || active === "overlay") && <>{surface("overlay")}{surface("dialog", <div className="material-preview-lines"><i /><i /></div>)}</>}
		</div>
	</div>;
}

function MaterialNumber({ label, value, unit, max, disabled, change }: {
	label: string; value: number; unit: string; max: number; disabled: boolean; change: (value: number) => void;
}) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	return <div className="material-number">
		<input type="range" aria-label={`${label}滑块`} min={0} max={max} step={0.1} value={value} disabled={disabled} onChange={(event) => change(Number(event.target.value))} />
		<Input type="number" aria-label={label} min={0} max={max} step="any" required value={text} disabled={disabled}
			onChange={(event) => { setText(event.target.value); if (event.target.validity.valid) change(Number(event.target.value)); }}
			onBlur={() => setText(String(value))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
		<span>{unit}</span>
	</div>;
}
