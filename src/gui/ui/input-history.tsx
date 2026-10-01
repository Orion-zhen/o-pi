import { useRef, useState, type PointerEvent } from "react";
import { History } from "lucide-react";
import { IconButton } from "./components/icon-button";
import { Input } from "./components/ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

export function InputHistory({ history, select, focusEditor }: { history: string[]; select: (text: string) => void; focusEditor: () => void }) {
	const [search, setSearch] = useState("");
	const searchInput = useRef<HTMLInputElement>(null);
	const preserveSearchFocus = (event: PointerEvent<HTMLDivElement>) => {
		if (document.activeElement === searchInput.current) event.preventDefault();
	};
	const filter = search.toLowerCase();
	const entries = history.map((text, index) => ({ text, index })).filter(({ text }) => text.toLowerCase().includes(filter)).reverse();
	return (
		<DropdownMenu onOpenChange={() => setSearch("")}>
			<DropdownMenuTrigger asChild>
				<IconButton label="输入历史" disabled={!history.length}>
					<History />
				</IconButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="history-menu"
				onKeyDown={(event) => {
					if (event.key !== "Tab") return;
					event.preventDefault();
					if (event.target === searchInput.current) event.currentTarget.focus();
					else searchInput.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					focusEditor();
				}}
			>
				<DropdownMenuLabel>输入历史</DropdownMenuLabel>
				<div className="history-menu-list">
					{entries.map(({ text, index }) => (
						<DropdownMenuItem key={index} className="hover:bg-accent hover:text-accent-foreground" onSelect={() => select(text)} onPointerMove={preserveSearchFocus} onPointerLeave={preserveSearchFocus}>
							{text.slice(0, 120)}
						</DropdownMenuItem>
					))}
					{entries.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground" role="status">无匹配的输入历史</p>}
				</div>
				<div className="history-menu-search">
					<Input
						ref={searchInput}
						aria-label="搜索输入历史"
						placeholder="搜索输入历史…"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
						}}
					/>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
