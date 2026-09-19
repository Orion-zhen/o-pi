import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Query, WorkspaceQuery } from "../contract.ts";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "../workbench.ts";
import { useWindowRefresh } from "./use-window-refresh.ts";

export type Remote<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

function visibleExpanded(expanded: Set<string>) {
	return [...expanded].filter((path) => {
		const parents = path.split("/").slice(0, -1);
		return parents.every((_, index) => expanded.has(parents.slice(0, index + 1).join("/")));
	});
}

export function useWorkbench(cwd: string | undefined, connected: boolean, running: boolean, query: Query<WorkspaceQuery>) {
	const [directories, setDirectories] = useState<Record<string, Remote<WorkspaceEntry[]>>>({});
	const [git, setGit] = useState<Remote<WorkspaceGit | null>>({ state: "loading" });
	const [preview, setPreview] = useState<{ path: string; result: Remote<FilePreview> }>();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [onlyChanges, setOnlyChanges] = useState(false);
	const [search, setSearch] = useState("");
	const [filesOpen, setFilesOpen] = useState(true);
	const [pane, setPane] = useState("sessions");
	const workspace = useRef<string | undefined>(undefined);
	const pending = useRef(new Map<string, { dirty: boolean }>());

	// 同一路径串行读取，读取期间的刷新合并为一次后续读取。
	const read = useCallback(async <T,>(key: string, task: () => Promise<T>, receive: (result: Remote<T>) => void) => {
		const previous = pending.current.get(key);
		if (previous) { previous.dirty = true; return; }
		const request = { dirty: true };
		pending.current.set(key, request);
		while (request.dirty && pending.current.get(key) === request) {
			request.dirty = false;
			let result: Remote<T>;
			try { result = { state: "ready", value: await task() }; }
			catch (error) { result = { state: "error", message: error instanceof Error ? error.message : String(error) }; }
			if (pending.current.get(key) === request && !request.dirty) {
				pending.current.delete(key);
				receive(result);
			}
		}
	}, []);

	const loadDirectory = useCallback((path: string) => {
		if (!cwd || !connected) return;
		setDirectories((current) => current[path]?.state === "ready" ? current : { ...current, [path]: { state: "loading" } });
		void read(`directory:${path}`, () => query({ query: "workspaceFiles", cwd, path }),
			(result) => setDirectories((current) => ({ ...current, [path]: result })));
	}, [cwd, connected, query, read]);
	const loadGit = useCallback(() => {
		if (cwd && connected) void read("git", () => query({ query: "workspaceGit", cwd }), setGit);
	}, [cwd, connected, query, read]);
	const loadPreview = useCallback((path: string) => {
		if (!cwd || !connected) return;
		for (const key of pending.current.keys()) if (key.startsWith("preview:") && key !== `preview:${path}`) pending.current.delete(key);
		setPreview((current) => current?.path === path && current.result.state === "ready" ? current : { path, result: { state: "loading" } });
		void read(`preview:${path}`, () => query({ query: "previewFile", cwd, path }), (result) => setPreview({ path, result }));
	}, [cwd, connected, query, read]);
	const refresh = useCallback(() => {
		loadDirectory("");
		for (const path of visibleExpanded(expanded)) if (directories[path]) loadDirectory(path);
		loadGit();
		if (preview) loadPreview(preview.path);
	}, [loadDirectory, loadGit, loadPreview, directories, expanded, preview?.path]);
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		pending.current.clear();
		if (workspace.current !== cwd) {
			workspace.current = cwd;
			setDirectories({});
			setGit({ state: "loading" });
			setPreview(undefined);
			setExpanded(new Set());
			setOnlyChanges(false);
			setSearch(""); setFilesOpen(true); setPane("sessions");
			loadDirectory("");
			loadGit();
		} else refreshRef.current();
		return () => { pending.current.clear(); };
	}, [loadDirectory, loadGit]);
	useWindowRefresh(connected, refresh);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) refreshRef.current();
		wasRunning.current = running;
	}, [running]);
	const closePreview = useCallback(() => {
		for (const key of pending.current.keys()) if (key.startsWith("preview:")) pending.current.delete(key);
		setPreview(undefined);
	}, []);
	const toggleDirectory = useCallback((path: string, virtual = false) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path); else next.add(path);
			return next;
		});
		if (!expanded.has(path)) {
			if (!virtual) loadDirectory(path);
			for (const child of visibleExpanded(new Set([...expanded, path]))) {
				if (child.startsWith(`${path}/`) && directories[child]) loadDirectory(child);
			}
		}
	}, [expanded, directories, loadDirectory]);
	const collapseAll = useCallback(() => setExpanded(new Set<string>()), []);
	return useMemo(() => ({
		directories, git, preview, expanded, onlyChanges, setOnlyChanges, refresh,
		search, setSearch, filesOpen, setFilesOpen, pane, setPane,
		openFile: loadPreview, closePreview, toggleDirectory, collapseAll,
	}), [directories, git, preview, expanded, onlyChanges, search, filesOpen, pane, refresh, loadPreview, closePreview, toggleDirectory, collapseAll]);
}
export type WorkbenchView = ReturnType<typeof useWorkbench>;
