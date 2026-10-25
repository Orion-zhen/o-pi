import { useId } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { SettingsRow } from "@/forms/settings-controls.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Reveal } from "@/ui/motion/animated.tsx";
import { fade, settle } from "@/ui/motion/transitions.ts";
import type { ChangeConfig } from "./service-draft.ts";
import { TemplateParamEditor, type TemplateValue } from "./service-template-param-editor.tsx";

const shortcuts = [
	["enable_thinking", { $var: "thinking.enabled" }],
	["reasoning_effort", { $var: "thinking.effort" }],
	["preserve_thinking", true],
] as const;

export function ServiceTemplateParams({ label, value, defaultValue, disabled, change }: {
	label: string;
	value: OpenAICompletionsCompat["chatTemplateKwargs"];
	defaultValue: OpenAICompletionsCompat["chatTemplateKwargs"];
	disabled: boolean;
	change: ChangeConfig;
}) {
	const id = useId();
	const present = useIsPresent();
	const own = value ?? {};
	const inherited = defaultValue ?? {};
	const effective = { ...inherited, ...own };
	const names = Object.keys(effective);
	const blocked = disabled || !present;
	const remove = (name: string) => {
		if (Object.keys(own).length === 1) change([], undefined);
		else change([name], undefined);
	};

	return <SettingsRow label={label} layout="wide" disabled={disabled || !present}
		reset={{ value: effective, defaultValue: inherited, apply: () => change([], undefined) }}>
		<div className="service-template-params" role="group" aria-label={label}>
			<div className="service-template-body"><AnimatePresence initial={false}>
				{names.length > 0 ? <Reveal key="table">
					<table className="service-template-table" aria-label={label}>
						<thead><tr><th scope="col">模板参数</th><th scope="col">取值类型</th><th aria-label="操作" /></tr></thead>
						<AnimatePresence initial={false}>{Object.entries(effective).map(([name, entry]) =>
							<TemplateParamRow key={name} idPrefix={id} name={name} value={entry} existing={names} disabled={blocked}
								source={Object.hasOwn(own, name) ? Object.hasOwn(inherited, name) ? "override" : "local" : "inherited"}
								change={change} remove={() => remove(name)} />)}
						</AnimatePresence>
					</table>
				</Reveal> : !blocked && <Reveal key="empty"><p className="service-tag">暂无参数</p></Reveal>}
			</AnimatePresence></div>
			<div className="service-template-toolbar">
				<TemplateParamEditor idPrefix={id} existing={names} disabled={blocked} apply={(name, entry) => change([name], entry)} />
				{shortcuts.filter(([name]) => !Object.hasOwn(effective, name)).map(([name, entry]) =>
					<Button key={name} type="button" variant="ghost" size="sm" disabled={blocked} aria-label={`添加 ${name}`}
						onClick={() => change([name], entry)}><Plus /><code>{name}</code></Button>)}
			</div>
		</div>
	</SettingsRow>;
}

function TemplateParamRow({ idPrefix, name, value, source, existing, disabled, change, remove }: {
	idPrefix: string;
	name: string;
	value: TemplateValue;
	source: "local" | "inherited" | "override";
	existing: string[];
	disabled: boolean;
	change: ChangeConfig;
	remove: () => void;
}) {
	const present = useIsPresent();
	const variable = typeof value === "object" && value !== null ? value : undefined;
	const inherited = source !== "local";
	const blocked = disabled || !present;
	return <motion.tbody className="service-template-entry" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
		exit={{ height: 0, opacity: 0 }} transition={{ ...settle, opacity: fade.transition }} inert={!present} aria-hidden={!present}
		style={{ minHeight: 0, overflow: "clip" }}>
		<tr className="service-template-param" aria-label={name}>
			<th scope="row" className="service-template-name" data-label="模板参数"><code>{name}</code>
				{inherited && <span className="service-tag">{source === "override" ? "已覆盖" : "继承"}</span>}
			</th>
			<td className="service-template-value" data-label="取值类型">
				<code>{variable ? variable.$var : JSON.stringify(value)}</code>
				{variable?.omitWhenOff && <span className="service-tag">omitWhenOff</span>}
			</td>
			<td className="service-template-actions">
				<TemplateParamEditor idPrefix={idPrefix} name={name} value={value} inherited={inherited} existing={existing} disabled={blocked}
					apply={(nextName, nextValue) => {
						if (nextName !== name) remove();
						change([nextName], nextValue);
					}} />
				{source !== "inherited" && <IconButton size="icon-sm" label={inherited ? `重置参数 ${name}` : `删除参数 ${name}`}
					tooltip={inherited ? "恢复继承" : "删除参数"} disabled={blocked} onClick={remove}>
					{inherited ? <RotateCcw /> : <Trash2 />}
				</IconButton>}
			</td>
		</tr>
	</motion.tbody>;
}
