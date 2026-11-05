import { useCallback, useEffect, useState } from "react";
import { ArrowUp, Folder, X } from "lucide-react";
import type { GlobalQuery, Query } from "../../../shared/protocol/queries.ts";
import { useRemote } from "@/connection/use-remote.ts";
import { Button } from "@/ui/button.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import { Input } from "@/ui/input.tsx";
import { SearchInput } from "@/ui/search-input.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

interface Props {
	gui: { globalQuery: Query<GlobalQuery> };
	initial: string; select: (path: string) => Promise<void>; close: () => void;
}
export function DirectoryBrowser(props: Props) { return <DirectoryDialog key={props.initial} {...props} />; }

function DirectoryDialog({ gui, initial, select, close }: Props) {
	const [path, setPath] = useState(initial);
	const [filter, setFilter] = useState("");
	const [request, setRequest] = useState({ path: initial });
	const [selecting, setSelecting] = useState(false);
	const [error, setError] = useState("");
	const load = useCallback(() => gui.globalQuery({ query: "directories", path: request.path }), [gui.globalQuery, request]);
	const { result } = useRemote(load);
	const pending = result.state === "loading" || selecting;
	useEffect(() => {
		if (result.state === "ready") { setPath(result.value.path); setFilter(""); }
	}, [result]);
	const browse = (path: string) => { setError(""); setRequest({ path }); };
	return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
		<DialogContent className="directory-browser">
			<header className="flex shrink-0 items-center justify-between gap-2">
				<DialogTitle>选择工作目录</DialogTitle>
				<DialogClose asChild><IconButton label="关闭目录选择"><X /></IconButton></DialogClose>
			</header>
			<DialogDescription>浏览 opi-web 所在机器的目录。</DialogDescription>
			<Feedback compact message={error} tone="error" />
			<Feedback compact message={result.state === "error" ? result.message : ""} tone="error" />
			<form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); browse(path); }}>
				<Input aria-label="工作目录" value={path} onChange={(event) => setPath(event.target.value)} />
				<Button type="submit" variant="outline" disabled={pending || !path.trim()}>前往</Button>
			</form>
			<SearchInput aria-label="筛选目录" placeholder="筛选目录" value={filter} onValueChange={setFilter} />
			{result.state === "ready" && <>
				<Button variant="ghost" className="justify-start" disabled={selecting || result.value.parent === result.value.path}
					onClick={() => browse(result.value.parent)}><ArrowUp />上级目录</Button>
				<div className="directory-list" aria-label="目录列表">
					{result.value.children.filter((child) => child.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((child) =>
						<Button key={child.path} variant="ghost" disabled={selecting} onClick={() => browse(child.path)}><Folder /><span>{child.name}</span></Button>)}
					{!result.value.children.length && <p>无子目录</p>}
				</div>
				<Button disabled={selecting} onClick={() => {
					setSelecting(true); setError("");
					void select(result.value.path).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
						.finally(() => setSelecting(false));
				}}>选择此目录</Button>
			</>}
			<Feedback message={result.state === "loading" ? "读取中…" : ""} />
		</DialogContent>
	</Dialog>;
}
