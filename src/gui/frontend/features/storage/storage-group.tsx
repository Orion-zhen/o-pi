import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Trash2 } from "lucide-react";
import { ArrowDownWideNarrow, ArrowUpDown, ArrowUpNarrowWide } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { StorageEntry, StorageGroup } from "../../../shared/storage.ts";
import { Hint } from "@/ui/tooltip.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Button } from "@/ui/button.tsx";
import { Checkbox } from "@/ui/checkbox.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { SearchInput } from "@/ui/search-input.tsx";
import { ListItem } from "@/ui/motion/animated.tsx";

const BATCH_SIZE = 25;
const sizeSortModes = {
	none: { next: "desc", label: "文件大小：不排序", icon: ArrowUpDown },
	desc: { next: "asc", label: "文件大小：降序", icon: ArrowDownWideNarrow },
	asc: { next: "none", label: "文件大小：升序", icon: ArrowUpNarrowWide },
} as const;
export function storageBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
export const storageTotal = (entries: StorageEntry[]) => entries.reduce((total, entry) => total + entry.bytes, 0);

export function StorageGroupView({ group, disabled, requestRemoval }: {
	group: StorageGroup; disabled: boolean; requestRemoval: (entries: StorageEntry[], button: HTMLButtonElement, heading: HTMLButtonElement | null) => void;
}) {
	const heading = useRef<HTMLButtonElement>(null);
	const [filter, setFilter] = useState("");
	const list = useRef<HTMLUListElement>(null);
	const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
	const [sizeSort, setSizeSort] = useState<keyof typeof sizeSortModes>("none");
	const sortMode = sizeSortModes[sizeSort];
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	useEffect(() => { setSelected(new Set()); }, [group]);
	const query = filter.trim().toLocaleLowerCase();
	const filtered = group.entries.filter((entry) => `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(query));
	if (sizeSort !== "none") filtered.sort((a, b) => sizeSort === "desc" ? b.bytes - a.bytes : a.bytes - b.bytes);
	const visible = filtered.slice(0, visibleCount);
	const available = filtered.filter((entry) => !entry.blocked);
	const chosen = group.entries.filter((entry) => !entry.blocked && selected.has(entry.id));
	const checked = available.length > 0 && available.every((entry) => selected.has(entry.id));
	const partial = available.some((entry) => selected.has(entry.id));
	const select = (ids: string[], value: boolean) => setSelected((previous) => {
		const next = new Set(previous);
		for (const id of ids) if (value) next.add(id); else next.delete(id);
		return next;
	});
	const resetWindow = () => {
		setVisibleCount(BATCH_SIZE);
		if (list.current) list.current.scrollTop = 0;
	};
	return <Collapsible className="storage-group" asChild><section aria-label={group.title}>
		<CollapsibleTrigger asChild><Button ref={heading} variant="ghost" className="storage-group-heading disclosure-trigger">
			<ChevronRight className="disclosure-chevron" aria-hidden="true" />
			<strong>{group.title}</strong><span className="storage-group-amount">{storageBytes(storageTotal(group.entries))} · {group.entries.length} 项{group.error ? " · 统计不完整" : ""}</span>
		</Button></CollapsibleTrigger>
		<CollapsibleContent lazy><div className="storage-group-body">
			<ul className="storage-paths" aria-label={`${group.title}路径`}>{group.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
			{group.error && <p role="alert">{group.error}</p>}
			{group.entries.length > 0 ? <>
				<SearchInput aria-label={`筛选${group.title}`} placeholder="按名称或路径筛选" value={filter} onValueChange={(value) => { setFilter(value); resetWindow(); }} />
				<div className="storage-list-actions">
					<label className="storage-select"><Checkbox aria-label={`全选可删除的${group.title}`} disabled={disabled || available.length === 0}
						checked={checked ? true : partial ? "indeterminate" : false} onCheckedChange={(value) => select(available.map((entry) => entry.id), value === true)} />全选</label>
					<Hint content={sizeSortModes[sortMode.next].label}><Button variant="outline" size="sm" onClick={() => { setSizeSort(sortMode.next); resetWindow(); }}>
						<MorphIcon icon={sortMode.icon} spring="smooth" size="1em" />{sortMode.label}</Button></Hint>
					<Button variant="outline" size="sm" className="storage-delete" disabled={disabled || chosen.length === 0 || chosen.length > 1000}
						onClick={(event) => requestRemoval(chosen, event.currentTarget, heading.current)}><Trash2 aria-hidden="true" />删除所选{chosen.length ? ` (${chosen.length})` : ""}</Button>
				</div>
				{chosen.length > 1000 && <p role="alert">每次最多删除 1000 个条目，请减少选择。</p>}
				<ul ref={list} className="storage-entries" aria-label={`${group.title}条目`} onScroll={(event) => {
					const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
					if (scrollHeight - scrollTop <= clientHeight * 2) setVisibleCount((count) => Math.min(count + BATCH_SIZE, filtered.length));
				}}><AnimatePresence initial={false}>
					{visible.map((entry) => <ListItem className="storage-entry" key={entry.path}>
						<Checkbox aria-label={`选择 ${entry.name}`} disabled={disabled || entry.blocked !== null} checked={selected.has(entry.id)} onCheckedChange={(value) => select([entry.id], value === true)} />
						<div className="storage-entry-text"><strong>{entry.name}</strong><code>{entry.path}</code>
							<span className="storage-entry-meta">{storageBytes(entry.bytes)}{entry.files === null ? "" : ` · ${entry.files} 个文件`}
								{entry.modified > 0 && <> · {new Date(entry.modified).toLocaleString("zh-CN")}</>}</span>
							{entry.blocked && <span className="storage-entry-meta">{entry.blocked}</span>}
						</div>
						<IconButton size="icon-sm" className="storage-delete" disabled={disabled || entry.blocked !== null} label={`删除 ${entry.name}`} tooltip="删除条目"
							onClick={(event) => requestRemoval([entry], event.currentTarget, heading.current)}><Trash2 aria-hidden="true" /></IconButton>
					</ListItem>)}
				</AnimatePresence></ul>
				{filtered.length === 0 && <p className="settings-empty">没有匹配的条目</p>}
			</> : !group.error && <p className="settings-empty">没有已识别的条目</p>}
		</div></CollapsibleContent>
	</section></Collapsible>;
}
