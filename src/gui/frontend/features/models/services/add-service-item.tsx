import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, useIsPresent, usePresence } from "motion/react";
import { Plus } from "lucide-react";
import { Input } from "@/ui/input.tsx";
import { Button } from "@/ui/button.tsx";

export function AddServiceItem({ label, existing, suggestions, disabled, add, cancel }: {
	label: string; existing: string[]; suggestions?: string[]; disabled: boolean; add: (id: string) => void; cancel: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState<string>();
	const listId = useId();
	const input = useRef<HTMLInputElement>(null);
	const form = useRef<HTMLFormElement>(null);
	const present = useIsPresent();
	const id = draft.trim();
	const duplicate = existing.includes(id);
	const matches = (suggestions ?? []).filter((value) => value.toLowerCase().includes(id.toLowerCase()));
	const expanded = open && !disabled && matches.length > 0;
	const activeIndex = matches.findIndex((value) => value === active);
	const optionId = expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
	const select = (value: string) => { setDraft(value); setOpen(false); setActive(undefined); };
	useEffect(() => {
		if (present) input.current?.focus();
		else { setDraft(""); setOpen(false); setActive(undefined); }
	}, [present]);
	useEffect(() => {
		if (optionId) document.getElementById(optionId)?.scrollIntoView({ block: "nearest" });
	}, [optionId]);
	useEffect(() => {
		if (!present) return;
		const dismiss = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || !form.current || !event.composedPath().includes(form.current)) return;
			event.preventDefault(); event.stopPropagation();
			if (expanded) { setOpen(false); setActive(undefined); }
			else cancel();
		};
		window.addEventListener("keydown", dismiss, true);
		return () => window.removeEventListener("keydown", dismiss, true);
	}, [expanded, present, cancel]);
	return <form ref={form} className="service-add" onSubmit={(event) => { event.preventDefault(); if (id && !duplicate && !disabled) add(id); }}>
		<Input ref={input} aria-label={label} placeholder={suggestions ? `输入或选择${label}` : label} value={draft} disabled={disabled}
			role={suggestions ? "combobox" : undefined} aria-autocomplete={suggestions ? "list" : undefined}
			aria-expanded={suggestions ? expanded : undefined} aria-controls={expanded ? listId : undefined}
			aria-activedescendant={optionId} aria-invalid={duplicate} autoComplete="off" spellCheck={false}
			onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => { setOpen(false); setActive(undefined); }}
			onChange={(event) => { setDraft(event.target.value); setOpen(true); setActive(undefined); }}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing) { if (event.key === "Enter") event.preventDefault(); return; }
				if (event.key === "Enter" && expanded && activeIndex >= 0 && active !== undefined) {
					event.preventDefault(); select(active);
				} else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length > 0) {
					event.preventDefault(); setOpen(true);
					const index = expanded ? activeIndex : -1;
					const next = index < 0 ? (event.key === "ArrowDown" ? 0 : matches.length - 1)
						: (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
					setActive(matches[next]);
				}
			}} />
		<div className="settings-action-buttons"><Button size="sm" type="submit" disabled={disabled || !id || duplicate}><Plus />添加</Button><Button size="sm" variant="ghost" type="button" onClick={cancel}>取消</Button></div>
		{duplicate && <p role="alert">{label}已存在</p>}
		<AnimatePresence>{expanded && <CandidateList key="candidates" id={listId} label={label} matches={matches} active={active} select={select} />}</AnimatePresence>
	</form>;
}

function CandidateList({ id, label, matches, active, select }: {
	id: string; label: string; matches: string[]; active: string | undefined; select: (value: string) => void;
}) {
	const [present, remove] = usePresence();
	return <div id={id} className="service-add-options" role="listbox" aria-label={`${label}候选`}
		data-state={present ? "open" : "closed"} inert={!present} aria-hidden={!present}
		onAnimationEnd={(event) => { if (!present && event.target === event.currentTarget) remove?.(); }}>
		{matches.map((value, index) => <button key={value} id={`${id}-${index}`} type="button" role="option" tabIndex={-1}
			aria-selected={value === active} onMouseDown={(event) => event.preventDefault()} onClick={() => select(value)}>{value}</button>)}
	</div>;
}
