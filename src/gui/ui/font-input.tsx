import { useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { fontFamily } from "./use-preferences.ts";

export function FontInput({ kind, fonts, selected, disabled, initial = "", commit, cancel }: {
	kind: "ui" | "code"; fonts: string[] | undefined; selected: string[]; disabled: boolean; initial?: string;
	commit: (font: string) => Promise<boolean>; cancel?: () => void;
}) {
	const [draft, setDraft] = useState(initial);
	const [expanded, setExpanded] = useState(false);
	const [active, setActive] = useState(-1);
	const input = useRef<HTMLInputElement>(null);
	const pending = useRef(false);
	const id = useId();
	const name = draft.trim();
	const alreadySelected = (font: string) => selected.some((value) => value.toLowerCase() === font.toLowerCase());
	const matches = (fonts ?? []).filter((font) => font.toLowerCase().includes(name.toLowerCase()));
	const options = matches.map((font) => ({ font, custom: false }));
	if (name && !matches.some((font) => font.toLowerCase() === name.toLowerCase())) options.push({ font: name, custom: true });
	const listOpen = expanded && options.length > 0;
	const save = async (font: string) => {
		if (disabled || pending.current || !font || alreadySelected(font)) return;
		pending.current = true;
		try {
			if (await commit(font)) {
				setDraft("");
				setExpanded(false);
				setActive(-1);
				input.current?.focus();
			}
		} finally { pending.current = false; }
	};
	return <div className="font-input">
		<div className="font-input-controls">
			<Input ref={input} autoFocus role="combobox" data-font-escape={expanded || Boolean(draft) || Boolean(cancel)} aria-label={`${cancel ? "修改" : "添加"}${kind === "ui" ? "界面" : "代码"}字体`}
				aria-autocomplete="list" aria-expanded={listOpen} aria-controls={listOpen ? id : undefined}
				aria-activedescendant={listOpen && active >= 0 ? `${id}-${active}` : undefined}
				placeholder="输入或搜索字体名称…" value={draft} readOnly={disabled} aria-disabled={disabled} maxLength={256} spellCheck={false}
				onFocus={() => setExpanded(true)} onBlur={() => { setExpanded(false); setActive(-1); }}
				onChange={(event) => { setDraft(event.target.value); setExpanded(true); setActive(-1); }}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || disabled) return;
					if (event.key === "Escape") {
						if (!expanded && !draft && !cancel) return;
						event.preventDefault(); event.stopPropagation();
						if (expanded) { setExpanded(false); setActive(-1); }
						else if (cancel) cancel();
						else setDraft("");
					} else if (event.key === "Enter") {
						event.preventDefault();
						void save((listOpen ? options[active]?.font : undefined) ?? name);
					} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault(); setExpanded(true);
						const available = options.flatMap((option, index) => alreadySelected(option.font) ? [] : [index]);
						const position = available.indexOf(active);
						const next = available[position < 0 ? (event.key === "ArrowDown" ? 0 : available.length - 1)
							: (position + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length];
						if (next !== undefined) {
							setActive(next);
							document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
						}
					}
				}} />
			{cancel ? <Button variant="outline" size="sm" disabled={disabled || !name || alreadySelected(name)} onClick={() => void save(name)}>保存</Button>
				: <IconButton label="添加" disabled={disabled || !name || alreadySelected(name)} onClick={() => void save(name)}><Plus /></IconButton>}
			{cancel && <IconButton label="取消修改字体" disabled={disabled} onClick={cancel}><X /></IconButton>}
		</div>
		{listOpen && <div id={id} className="font-list" role="listbox" aria-label="字体补全">
			{options.map(({ font, custom }, index) => <button key={font} id={`${id}-${index}`} type="button" role="option" tabIndex={-1}
				aria-selected={active === index} disabled={disabled || alreadySelected(font)}
				onMouseDown={(event) => event.preventDefault()} onClick={() => void save(font)}>
				<span style={custom ? undefined : { fontFamily: fontFamily([font], kind) }}>{custom ? `使用自定义字体名 “${font}”` : font}</span>
				{(!custom || alreadySelected(font)) && <small>{alreadySelected(font) ? "已添加" : "本机"}</small>}
			</button>)}
		</div>}
	</div>;
}
