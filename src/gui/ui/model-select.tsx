import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { GuiModel } from "../contract.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { ListScroll } from "./components/list-scroll";
import { Fade } from "./components/animated";
import { fade, settle } from "./lib/motion";

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
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={label}
					className="model-select bg-(--surface)" disabled={disabled} title={value ?? undefined}>
					<span className="model-select-value">{selected?.name ?? value ?? "使用当前模型"}</span>
					<ChevronsUpDown />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="model-select-content" align="end">
				<Input aria-label="搜索模型" placeholder="搜索模型" value={filter} onChange={(event) => setFilter(event.target.value)} />
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
