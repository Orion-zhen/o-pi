import { useEffect, useState } from "react";
import { ArrowUp, Folder, X } from "lucide-react";
import type { GuiView } from "./use-gui.ts";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { IconButton } from "./components/icon-button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";

export function DirectoryBrowser({ gui, initial, select, close }: {
	gui: GuiView; initial: string; select: (path: string) => Promise<void>; close: () => void;
}) {
	const [path, setPath] = useState(initial);
	const [filter, setFilter] = useState("");
	const [pending, setPending] = useState(true);
	const [loaded, setLoaded] = useState(false);
	useEffect(() => {
		let active = true;
		gui.setError("");
		void gui.send({ action: "directories", path: initial }).then((ok) => {
			if (active) { setLoaded(ok); setPending(false); }
		});
		return () => { active = false; };
	}, [initial, gui.send, gui.setError]);
	useEffect(() => { if (loaded && gui.directories) setPath(gui.directories.path); }, [loaded, gui.directories]);
	const browse = async (path: string) => {
		gui.setError("");
		setPending(true);
		try { if (await gui.send({ action: "directories", path })) { setLoaded(true); setFilter(""); } }
		finally { setPending(false); }
	};
	const listing = loaded ? gui.directories : undefined;
	return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
		<DialogContent className="directory-browser" showCloseButton={false}>
			<header className="flex shrink-0 items-center justify-between gap-2">
				<DialogTitle>选择工作目录</DialogTitle>
				<DialogClose asChild><IconButton label="关闭目录选择"><X /></IconButton></DialogClose>
			</header>
			<DialogDescription>浏览 opi-web 所在机器的目录。</DialogDescription>
			{gui.error && <p role="alert">{gui.error}</p>}
			<form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void browse(path); }}>
				<Input aria-label="工作目录" value={path} onChange={(event) => setPath(event.target.value)} />
				<Button type="submit" variant="outline" disabled={pending || !path.trim()}>前往</Button>
			</form>
			<Input aria-label="筛选目录" placeholder="筛选目录" value={filter} onChange={(event) => setFilter(event.target.value)} />
			<Button variant="ghost" className="justify-start" disabled={pending || !listing || listing.parent === listing.path}
				onClick={() => { if (listing) void browse(listing.parent); }}><ArrowUp />上级目录</Button>
			<div className="directory-list" aria-label="目录列表" aria-busy={pending}>
				{listing?.children.filter((child) => child.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((child) =>
					<Button key={child.path} variant="ghost" disabled={pending} onClick={() => void browse(child.path)}><Folder /><span>{child.name}</span></Button>)}
				{listing && !listing.children.length && <p>无子目录</p>}
			</div>
			<Button disabled={pending || !listing} onClick={() => {
				if (!listing) return;
				setPending(true);
				void select(listing.path).finally(() => setPending(false));
			}}>选择此目录</Button>
		</DialogContent>
	</Dialog>;
}
