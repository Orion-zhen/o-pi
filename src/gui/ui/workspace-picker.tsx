import { useState } from "react";
import { Check, ChevronsUpDown, FolderOpen } from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { DirectoryBrowser } from "./directory-browser.tsx";
import { ConfirmAction } from "./confirm-action.tsx";

export function WorkspacePicker({ gui, close, compact = false }: { gui: GuiView; close: () => void; compact?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [filter, setFilter] = useState("");
	const [pending, setPending] = useState(false);
	const cwd = gui.snapshot?.cwd ?? gui.workspaceRoot;
	const workspaces = gui.workspaces;
	const open = async (directory: string) => {
		setPending(true);
		try {
			if (directory === gui.snapshot?.cwd || await gui.send({ action: "workspace", path: directory })) {
				setExpanded(false);
				setBrowsing(false);
				close();
			}
		} finally { setPending(false); }
	};
	const disabled = pending || Boolean(gui.snapshot?.busy) || gui.running || gui.status !== "已连接";
	return <>
		<Popover open={expanded} onOpenChange={(value) => { setExpanded(value); setFilter(""); }}>
			<PopoverTrigger asChild><Button variant="outline" role="combobox" aria-label="工作区" aria-expanded={expanded}
				className="workspace-select" title={cwd} disabled={disabled}>
				<FolderOpen />{!compact && <><span>{cwd.split(/[/\\]/).filter(Boolean).at(-1) || "选择工作区"}</span><ChevronsUpDown /></>}
			</Button></PopoverTrigger>
			<PopoverContent className="workspace-options">
				<Input aria-label="筛选工作区" placeholder="筛选工作区" value={filter} onChange={(event) => setFilter(event.target.value)} />
				<div role="listbox" aria-label="工作区列表" className="workspace-list">
					{workspaces.filter(({ path }) => path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ path, exists }) =>
						<div className="workspace-option-row overlay-list-row" key={path}>
							<Button role="option" aria-label={path} aria-selected={path === gui.snapshot?.cwd} variant="ghost"
								disabled={disabled || !exists} title={path} onClick={() => void open(path)}>
								<span>{path}{!exists && <small>目录不存在</small>}</span>{path === gui.snapshot?.cwd && <Check />}
							</Button>
							{path !== gui.workspaceRoot && path !== gui.snapshot?.cwd && <div className="row-actions">
								<ConfirmAction label={`移除工作区 ${path}`} hint="仅从列表移除，保留目录和历史会话"
									disabled={disabled} confirm={() => gui.send({ action: "removeWorkspace", path })} />
							</div>}
						</div>)}
				</div>
				<Button variant="outline" disabled={disabled} onClick={() => {
					if (window.opi) {
						void window.opi.chooseDirectory().then(async (directory) => { if (directory) await open(directory); })
							.catch((error: unknown) => gui.setError(String(error)));
					} else { setExpanded(false); setBrowsing(true); }
				}}><FolderOpen />选择目录</Button>
			</PopoverContent>
		</Popover>
		{browsing && <DirectoryBrowser gui={gui} initial={cwd} select={open} close={() => setBrowsing(false)} />}
	</>;
}
