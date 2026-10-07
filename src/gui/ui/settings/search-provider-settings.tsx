import { useId } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { ModuleConfigChoice } from "../../module-config.ts";
import { ListItem } from "../components/animated";
import { IconButton } from "../components/icon-button";
import { Switch } from "../components/ui/switch";
import "./search-provider-settings.css";

export function SearchProviderSettings({ path, choices, valueAt, defaultAt, change, disabled }: {
	path: string;
	choices: readonly ModuleConfigChoice[] | undefined;
	valueAt: (path: string) => unknown;
	defaultAt: (path: string) => unknown;
	change: (path: string, value: unknown) => void;
	disabled: boolean;
}) {
	const id = useId();
	const reducedMotion = useReducedMotion();
	const value = valueAt(path);
	const order = readOrder(value, choices);
	const providersPath = path.slice(0, path.lastIndexOf("."));
	const move = (provider: string, direction: -1 | 1) => {
		if (!order || disabled) return;
		const next = order.map((choice) => choice.value);
		const index = next.indexOf(provider);
		next.splice(index, 1);
		next.splice(index + direction, 0, provider);
		change(path, next);
	};
	return <div className="search-provider-settings">
		{order ? <ul className="search-provider-list" aria-label="搜索引擎顺序">
			{order.map(({ value: provider, label }, index) => {
				const enabledPath = `${providersPath}.${provider}.enabled`;
				const enabled = valueAt(enabledPath);
				return <ListItem key={provider} className="search-provider-row" initial={false}
					{...(reducedMotion ? { transition: { duration: 0, layout: { duration: 0 } } } : {})}>
					<div className="search-provider-label">
						<label htmlFor={`${id}-${provider}`}>{label}</label>
						{enabled !== defaultAt(enabledPath) && <IconButton label={`重置${label}`} tooltip="恢复默认" size="icon-sm" disabled={disabled}
							onClick={() => change(enabledPath, undefined)}><RotateCcw /></IconButton>}
					</div>
					<div className="search-provider-actions">
						<IconButton label={`上移 ${label}`} tooltip="上移" size="icon-sm" disabled={disabled || index === 0}
							onClick={() => move(provider, -1)}><ArrowUp /></IconButton>
						<IconButton label={`下移 ${label}`} tooltip="下移" size="icon-sm" disabled={disabled || index === order.length - 1}
							onClick={() => move(provider, 1)}><ArrowDown /></IconButton>
						<Switch id={`${id}-${provider}`} checked={enabled === true} disabled={disabled} onCheckedChange={(checked) => change(enabledPath, checked)} />
					</div>
				</ListItem>;
			})}
		</ul> : <p role="alert">搜索引擎顺序无效。请恢复默认顺序或编辑 JSONC。</p>}
		<div className="sr-only" role="status">{order && `当前顺序：${order.map((choice) => choice.label).join("、")}`}</div>
	</div>;
}

function readOrder(value: unknown, choices: readonly ModuleConfigChoice[] | undefined): ModuleConfigChoice[] | undefined {
	if (!choices || !Array.isArray(value) || value.length !== choices.length || new Set(value).size !== value.length) return undefined;
	const order = value.map((id: unknown) => choices.find((choice) => choice.value === id));
	return order.every((choice): choice is ModuleConfigChoice => choice !== undefined) ? order : undefined;
}
