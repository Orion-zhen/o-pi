import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover.tsx";
import { FontInput } from "./font-input.tsx";
import { genericFamilies } from "./use-preferences.ts";
import type { LocalFonts } from "./use-local-fonts.ts";

type Props = {
	kind: "ui" | "code"; value: string[]; disabled: boolean; local: LocalFonts;
	onChange: (value: string[]) => void;
};

export function FontPicker(props: Props) {
	const label = props.kind === "ui" ? "界面字体" : "代码字体";
	const summary = props.value.length > 0 ? props.value.join(", ") : "系统默认";
	return <Popover>
		<PopoverTrigger asChild><Button variant="outline" className="font-trigger" aria-label={label} disabled={props.disabled}>
			<span>{summary}</span><ChevronDown />
		</Button></PopoverTrigger>
		<PopoverContent className="settings-popover font-picker" align="end" aria-label={`${label}链`} onEscapeKeyDown={(event) => {
			// Radix 在捕获阶段关闭浮层，先让输入框消费补全和草稿的 Escape。
			if (event.target instanceof Element && event.target.closest('[data-font-escape="true"]')) event.preventDefault();
		}}>
			<FontChainEditor {...props} />
		</PopoverContent>
	</Popover>;
}

function FontChainEditor({ kind, value, disabled, local, onChange }: Props) {
	const [editing, setEditing] = useState<string>();
	useEffect(() => { if (editing && !value.includes(editing)) setEditing(undefined); }, [value, editing]);
	const move = (font: string, index: number, direction: -1 | 1) => {
		const next = [...value];
		next.splice(index, 1);
		next.splice(index + direction, 0, font);
		onChange(next);
	};
	return <>
		<header><strong>{kind === "ui" ? "界面字体" : "代码字体"}</strong></header>
		<div className="font-local-controls">
			<Button variant="outline" size="sm" disabled={!local.supported || local.loading} onClick={() => void local.load()}>
				{local.loading ? "正在读取字体…" : local.fonts ? "刷新本机字体" : "读取本机字体"}
			</Button>
		</div>
		{!local.supported && <p role="status">无法读取本机字体</p>}
		{local.error && <p role="alert">{local.error}</p>}
		<ol className="font-chain" aria-label="字体优先顺序">
			{value.map((font, index) => <li key={font}>
				{editing === font ? <FontInput kind={kind} fonts={local.fonts} selected={value.filter((_, position) => position !== index)}
					disabled={disabled} initial={font} cancel={() => setEditing(undefined)} commit={(next) => {
						if (next !== font) onChange(value.map((item, position) => position === index ? next : item));
						setEditing(undefined);
					}} /> : <>
					<span className="font-chain-index" aria-hidden="true">{index + 1}</span>
					<button type="button" className="font-chain-name" aria-label={`修改字体 ${font}`} disabled={disabled} onClick={() => setEditing(font)}>
						<span>{font}</span>
						{local.fonts && local.fonts.length > 0 && !genericFamilies.has(font.toLowerCase()) && !local.fonts.some((family) => family.toLowerCase() === font.toLowerCase())
							&& <small>本机列表未找到</small>}
					</button>
					<IconButton size="icon-sm" label={`上移 ${font}`} tooltip="上移" disabled={disabled || index === 0} onClick={() => move(font, index, -1)}><ArrowUp /></IconButton>
					<IconButton size="icon-sm" label={`下移 ${font}`} tooltip="下移" disabled={disabled || index === value.length - 1} onClick={() => move(font, index, 1)}><ArrowDown /></IconButton>
					<IconButton size="icon-sm" label={`删除 ${font}`} tooltip="删除字体" disabled={disabled} onClick={() => onChange(value.filter((_, position) => position !== index))}><X /></IconButton>
				</>}
			</li>)}
		</ol>
		{!editing && <FontInput kind={kind} fonts={local.fonts} selected={value} disabled={disabled} commit={(font) => onChange([...value, font])} />}
	</>;
}
