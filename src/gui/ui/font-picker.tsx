import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { IconButton } from "./components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { FontInput } from "./font-input.tsx";
import { genericFamilies } from "./use-preferences.ts";
import type { LocalFonts } from "./use-local-fonts.ts";

type Props = {
	kind: "ui" | "code"; value: string[]; disabled: boolean; local: LocalFonts;
	onChange: (value: string[]) => Promise<boolean>;
};

export function FontPicker(props: Props) {
	const label = props.kind === "ui" ? "界面字体" : "代码字体";
	const [first, ...rest] = props.value;
	return <Popover>
		<PopoverTrigger asChild><Button variant="outline" className="font-trigger" aria-label={label} disabled={props.disabled}>
			<span>{first ? `${first}${rest.length ? ` + ${rest.length} 个后备字体` : ""}` : "系统默认"}</span><ChevronDown />
		</Button></PopoverTrigger>
		<PopoverContent className="font-picker" align="end" aria-label={`${label}链`} onEscapeKeyDown={(event) => {
			// Radix 在捕获阶段关闭浮层，先让输入框消费补全和草稿的 Escape。
			if (event.target instanceof Element && event.target.closest('[data-font-escape="true"]')) event.preventDefault();
		}}>
			<FontChainEditor {...props} />
		</PopoverContent>
	</Popover>;
}

function FontChainEditor({ kind, value, disabled, local, onChange }: Props) {
	const [editing, setEditing] = useState<string>();
	const [error, setError] = useState("");
	const pending = useRef(false);
	useEffect(() => { if (editing && !value.includes(editing)) setEditing(undefined); }, [value, editing]);
	const save = async (next: string[]) => {
		if (disabled || pending.current) return false;
		pending.current = true;
		setError("");
		try {
			const saved = await onChange(next);
			if (!saved) setError("保存失败，字体链未更改。");
			return saved;
		} finally { pending.current = false; }
	};
	const move = (font: string, index: number, direction: -1 | 1) => {
		const next = [...value];
		next.splice(index, 1);
		next.splice(index + direction, 0, font);
		void save(next);
	};
	return <>
		<header><strong>{kind === "ui" ? "界面字体" : "代码字体"}</strong><p>按顺序匹配，缺少字符时使用后面的字体。</p></header>
		<div className="font-local-controls">
			<Button variant="outline" size="sm" disabled={!local.supported || local.loading} onClick={() => void local.load()}>
				{local.loading ? "正在读取字体…" : local.fonts ? "刷新本机字体" : "读取本机字体"}
			</Button>
			<span>当前设备</span>
		</div>
		{!local.supported && <p role="status">当前浏览器或访问地址不支持读取本机字体，仍可手写。读取需要支持此功能的浏览器及 HTTPS 或 localhost。</p>}
		{local.error && <p role="alert">{local.error}</p>}
		<ol className="font-chain" aria-label="字体优先顺序">
			{value.map((font, index) => <li key={font}>
				{editing === font ? <FontInput kind={kind} fonts={local.fonts} selected={value.filter((_, position) => position !== index)}
					disabled={disabled} initial={font} cancel={() => setEditing(undefined)} commit={async (next) => {
						const saved = next === font || await save(value.map((item, position) => position === index ? next : item));
						if (saved) setEditing(undefined);
						return saved;
					}} /> : <>
					<span className="font-chain-index" aria-hidden="true">{index + 1}</span>
					<button type="button" className="font-chain-name" aria-label={`修改字体 ${font}`} disabled={disabled} onClick={() => setEditing(font)}>
						<span>{font}</span>
						{local.fonts && local.fonts.length > 0 && !genericFamilies.has(font.toLowerCase()) && !local.fonts.some((family) => family.toLowerCase() === font.toLowerCase())
							&& <small>本机列表未找到</small>}
					</button>
					<IconButton label={`上移 ${font}`} disabled={disabled || index === 0} onClick={() => move(font, index, -1)}><ArrowUp /></IconButton>
					<IconButton label={`下移 ${font}`} disabled={disabled || index === value.length - 1} onClick={() => move(font, index, 1)}><ArrowDown /></IconButton>
					<IconButton label={`删除 ${font}`} disabled={disabled} onClick={() => void save(value.filter((_, position) => position !== index))}><X /></IconButton>
				</>}
			</li>)}
		</ol>
		{!editing && <FontInput kind={kind} fonts={local.fonts} selected={value} disabled={disabled} commit={(font) => save([...value, font])} />}
		<p className="font-fallback">最终回退：系统默认 <code>{kind === "ui" ? "system-ui, sans-serif" : "ui-monospace, monospace"}</code></p>
		{error && <p role="alert">{error}</p>}
	</>;
}
