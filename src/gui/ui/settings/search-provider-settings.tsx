import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, RotateCcw } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { ModuleConfigChoice } from "../../module-config.ts";
import { ListItem } from "../components/animated";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Switch } from "../components/ui/switch";
import { ExternalLink } from "../content/content";
import "./search-provider-settings.css";

const providerWebsites: Readonly<Record<string, string | undefined>> = {
	brave_api: "https://brave.com/search/api/",
	exa_api: "https://exa.ai",
	exa_mcp: "https://exa.ai",
	tavily: "https://tavily.com",
	tinyfish: "https://tinyfish.ai",
	anysearch: "https://anysearch.com",
};

export function SearchProviderSettings({ path, choices, valueAt, defaultAt, change, changeGroups, disabled, renderDetails }: {
	path: string;
	choices: readonly ModuleConfigChoice[] | undefined;
	valueAt: (path: string) => unknown;
	defaultAt: (path: string) => unknown;
	change: (path: string, value: unknown) => void;
	changeGroups: (changes: Record<string, unknown>) => void;
	disabled: boolean;
	renderDetails: (prefix: string) => ReactNode;
}) {
	const [expanded, setExpanded] = useState<string>();
	const reducedMotion = useReducedMotion();
	const providersPath = path.slice(0, path.lastIndexOf("."));
	const auxiliaryPath = `${providersPath}.auxiliary_providers`;
	const primary = readOrder(valueAt(path), choices);
	const auxiliary = readOrder(valueAt(auxiliaryPath), choices);
	if (!primary || !auxiliary || !choices || new Set([...primary, ...auxiliary].map(({ value }) => value)).size !== choices.length
		|| primary.length + auxiliary.length !== choices.length) {
		return <p role="alert">搜索引擎分组无效。请恢复默认分组或编辑 JSONC。</p>;
	}
	const groups = [
		{ path, label: "主搜索引擎", order: primary, otherPath: auxiliaryPath, other: auxiliary, target: "辅助" },
		{ path: auxiliaryPath, label: "辅助搜索引擎", order: auxiliary, otherPath: path, other: primary, target: "主" },
	];
	return <div className="search-provider-settings">{groups.map((group) => {
		const move = (provider: string, direction: -1 | 1) => {
			const next = group.order.map((choice) => choice.value);
			const index = next.indexOf(provider);
			next.splice(index, 1);
			next.splice(index + direction, 0, provider);
			change(group.path, next);
		};
		return <div key={group.path}>
			<h3>{group.label}</h3>
			<ul className="search-provider-list" aria-label={`${group.label}顺序`}>
				{group.order.map(({ value: provider, label }, index) => {
					const prefix = `${providersPath}.${provider}`;
					const enabledPath = `${prefix}.enabled`;
					const enabled = valueAt(enabledPath);
					const open = expanded === provider;
					const website = providerWebsites[provider];
					return <ListItem key={provider} className="search-provider-row" initial={false}
						{...(reducedMotion ? { transition: { duration: 0, layout: { duration: 0 } } } : {})}>
						<Collapsible open={open} onOpenChange={(next) => setExpanded(next ? provider : undefined)}>
							<div className="search-provider-heading">
								<div className="search-provider-label">
									<div className="search-provider-title">
										<CollapsibleTrigger asChild><button type="button" className="search-provider-name" aria-label={`编辑 ${label}`}>{label}</button></CollapsibleTrigger>
										{enabled !== defaultAt(enabledPath) && <IconButton label={`重置${label}`} tooltip="恢复默认" size="icon-sm" disabled={disabled}
											onClick={() => change(enabledPath, undefined)}><RotateCcw /></IconButton>}
									</div>
									{website && <ExternalLink href={website} className="search-provider-website">{website}</ExternalLink>}
								</div>
								<div className="search-provider-actions">
									<Button variant="ghost" size="sm" aria-label={`设为${group.target}引擎 ${label}`} disabled={disabled} onClick={() => changeGroups({
										[group.path]: group.order.filter((choice) => choice.value !== provider).map((choice) => choice.value),
										[group.otherPath]: [...group.other.map((choice) => choice.value), provider],
									})}>{`设为${group.target}引擎`}</Button>
									<IconButton label={`上移 ${label}`} tooltip="上移" size="icon-sm" disabled={disabled || index === 0}
										onClick={() => move(provider, -1)}><ArrowUp /></IconButton>
									<IconButton label={`下移 ${label}`} tooltip="下移" size="icon-sm" disabled={disabled || index === group.order.length - 1}
										onClick={() => move(provider, 1)}><ArrowDown /></IconButton>
									<Switch aria-label={label} checked={enabled === true} disabled={disabled} onCheckedChange={(checked) => change(enabledPath, checked)} />
									<CollapsibleTrigger className="disclosure-trigger" asChild><Button variant="ghost" size="icon-sm" aria-label={`${open ? "收起" : "展开"} ${label}`}><ChevronRight className="disclosure-chevron" /></Button></CollapsibleTrigger>
								</div>
							</div>
							<CollapsibleContent lazy><div className="search-provider-details">{renderDetails(prefix)}</div></CollapsibleContent>
						</Collapsible>
					</ListItem>;
				})}
			</ul>
			<div className="sr-only" role="status">{`${group.label}顺序：${group.order.map((choice) => choice.label).join("、")}`}</div>
		</div>;
	})}</div>;
}

function readOrder(value: unknown, choices: readonly ModuleConfigChoice[] | undefined): ModuleConfigChoice[] | undefined {
	if (!choices || !Array.isArray(value) || new Set(value).size !== value.length) return undefined;
	const order = value.map((id: unknown) => choices.find((choice) => choice.value === id));
	return order.every((choice): choice is ModuleConfigChoice => choice !== undefined) ? order : undefined;
}
