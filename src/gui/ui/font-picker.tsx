import { useId, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { fontFamily } from "./use-preferences.ts";

interface LocalFontWindow extends Window {
	queryLocalFonts?: () => Promise<{ family: string }[]>;
}

export function FontPicker({ kind, value, disabled, onChange }: {
	kind: "ui" | "code"; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
	const label = kind === "ui" ? "界面字体" : "代码字体";
	const defaultFont = kind === "ui" ? "system-ui" : "monospace";
	const [open, setOpen] = useState(false);
	const [fonts, setFonts] = useState<string[]>();
	const [filter, setFilter] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	const load = async () => {
		const localWindow: LocalFontWindow = window;
		if (!localWindow.queryLocalFonts) {
			setError("当前浏览器或访问地址不支持读取本机字体。请使用支持本地字体访问的浏览器及 HTTPS 或 localhost。");
			return;
		}
		setLoading(true);
		setError("");
		try {
			const available = await localWindow.queryLocalFonts();
			setFonts([...new Set(available.map((font) => font.family))].sort((a, b) => a.localeCompare(b)));
			if (available.length === 0) setError("未获得本机字体列表，请检查字体访问权限。");
		} catch (error) { setError(`无法读取本机字体，请检查字体访问权限。${error instanceof Error ? error.message : String(error)}`); }
		finally { setLoading(false); }
	};
	const options = [defaultFont, ...(fonts ?? [])].filter((font) => font.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
	const choose = (font: string) => { onChange(font); setOpen(false); };
	return <Popover open={open} onOpenChange={(open) => { setOpen(open); if (open) setFilter(""); }}>
		<PopoverTrigger asChild><Button variant="outline" className="font-trigger" role="combobox" aria-label={label}
			aria-expanded={open} aria-controls={id} disabled={disabled}>
			<span>{value === defaultFont ? "系统默认" : value}</span><ChevronsUpDown />
		</Button></PopoverTrigger>
		<PopoverContent className="font-picker" onKeyDown={(event) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
			const current = options.findIndex((option) => option === document.activeElement);
			const next = current < 0 ? 0 : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
			options[next]?.focus();
			event.preventDefault();
		}}>
			<Input aria-label={`搜索${label}`} placeholder="搜索字体…" value={filter} onChange={(event) => setFilter(event.target.value)} />
			<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>{loading ? "正在读取字体…" : fonts ? "刷新本机字体" : "读取本机字体"}</Button>
			{error && <p role="alert">{error}</p>}
			{fonts && value !== defaultFont && !fonts.includes(value) && <p role="status">当前设备未找到已选字体：{value}</p>}
			<div id={id} className="font-list" role="listbox" aria-label={label} ref={list}>
				{options.map((font) => <button key={font} type="button" role="option" aria-selected={font === value} onClick={() => choose(font)} style={{ fontFamily: fontFamily(font, kind) }}>
					<span>{font === defaultFont ? "系统默认" : font}</span>{font === value && <Check aria-hidden="true" />}
				</button>)}
				{options.length === 0 && <p>没有匹配的字体。</p>}
			</div>
		</PopoverContent>
	</Popover>;
}
