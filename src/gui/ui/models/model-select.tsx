import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import type { GuiModel } from "../../contract.ts";
import { Hint } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import { SearchInput } from "../components/search-input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ListScroll } from "../components/list-scroll";
import { Fade } from "../components/animated";
import { fade, settle } from "../lib/motion";
import "./models.css";

const modelKey = (model: GuiModel) => `${model.provider}/${model.id}`;

export function ModelSelect({ label, models, value, disabled, change }: {
	label: string; models: GuiModel[]; value: string | null; disabled: boolean; change: (value: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const query = filter.trim().toLocaleLowerCase();
	const visible = query
		? models.filter((model) => `${model.name} ${modelKey(model)}`.toLocaleLowerCase().includes(query))
		: models;
	const selected = models.find((model) => modelKey(model) === value);
	const pick = (next: string | null) => { change(next); setOpen(false); };
	return (
		<Popover open={open} onOpenChange={(next) => { setOpen(next); setFilter(""); }}>
			<Hint content={value ?? undefined} disabled={open}><PopoverTrigger asChild>
				<Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={label}
					className="model-select bg-(--surface)" disabled={disabled}>
					<span className="model-select-value">
						<span className="model-select-name">{selected?.name ?? value ?? "使用当前模型"}</span>
						{selected && <small className="model-select-provider">· {selected.provider}</small>}
					</span>
					<ChevronDown />
				</Button>
			</PopoverTrigger></Hint>
			<PopoverContent className="settings-popover model-select-content" align="end">
				<SearchInput aria-label="搜索模型" placeholder="搜索模型" value={filter} onValueChange={setFilter} />
				<ListScroll>
					<div role="listbox" aria-label="模型列表" className="model-select-list">
						<AnimatePresence initial={false}>
							{value !== null && <Fade layout="position" transition={{ ...fade.transition, layout: settle }} className="model-select-row">
								<Button type="button" role="option" aria-selected={false} variant="ghost" onClick={() => pick(null)}>留空（使用当前模型）</Button>
							</Fade>}
							{visible.map((model) => <Fade key={modelKey(model)} layout="position" transition={{ ...fade.transition, layout: settle }} className="model-select-row">
								<Button type="button" role="option" aria-selected={modelKey(model) === value} variant="ghost" onClick={() => pick(modelKey(model))}>
									<span className="model-select-label">{model.name}<small>{modelKey(model)}</small></span>
									{modelKey(model) === value && <Check />}
								</Button>
							</Fade>)}
						</AnimatePresence>
					</div>
				</ListScroll>
				{visible.length === 0 && <p className="model-select-empty">{query ? "无匹配模型" : "暂无可用模型"}</p>}
			</PopoverContent>
		</Popover>
	);
}
