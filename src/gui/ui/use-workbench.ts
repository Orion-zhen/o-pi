import { useCallback, useEffect, useRef, useState } from "react";
import type { Query } from "../contract.ts";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "../workbench.ts";
import { useWindowRefresh } from "./use-window-refresh.ts";

export type Remote<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

export function useWorkbench(cwd: string | undefined, connected: boolean, running: boolean, query: Query) {
	const [directories, setDirectories] = useState<Record<string, Remote<WorkspaceEntry[]>>>({});
	const [git, setGit] = useState<Remote<WorkspaceGit | null>>({ state: "loading" });
	const [preview, setPreview] = useState<{ path: string; result: Remote<FilePreview> }>();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [onlyChanges, setOnlyChanges] = useState(false);
	const latest = useRef(new Map<string, symbol>());

	// 只丢弃被替代的读取，不管理跨进程请求 ID 或响应回调。
	const read = useCallback(async <T,>(key: string, task: Promise<T>, receive: (result: Remote<T>) => void) => {
		const version = Symbol();
		latest.current.set(key, version);
		let result: Remote<T>;
		try { result = { state: "ready", value: await task }; }
		catch (error) { result = { state: "error", message: error instanceof Error ? error.message : String(error) }; }
		if (latest.current.get(key) === version) {
			latest.current.delete(key);
			receive(result);
		}
	}, []);

	const loadDirectory = useCallback((path: string) => {
		if (!cwd || !connected) return;
		setDirectories((current) => current[path]?.state === "ready" ? current : { ...current, [path]: { state: "loading" } });
		void read(`directory:${path}`, query({ query: "workspaceFiles", cwd, path }),
			(result) => setDirectories((current) => ({ ...current, [path]: result })));
	}, [cwd, connected, query, read]);
	const loadGit = useCallback(() => {
		if (cwd && connected) void read("git", query({ query: "workspaceGit", cwd }), setGit);
	}, [cwd, connected, query, read]);
	const loadPreview = useCallback((path: string) => {
		if (!cwd || !connected) return;
		setPreview((current) => current?.path === path && current.result.state === "ready" ? current : { path, result: { state: "loading" } });
		void read("preview", query({ query: "previewFile", cwd, path }), (result) => setPreview({ path, result }));
	}, [cwd, connected, query, read]);
	const refresh = useCallback(() => {
		loadDirectory("");
		for (const path of expanded) loadDirectory(path);
		loadGit();
		if (preview) loadPreview(preview.path);
	}, [loadDirectory, loadGit, loadPreview, expanded, preview?.path]);
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		latest.current.clear();
		setDirectories({});
		setGit({ state: "loading" });
		setPreview(undefined);
		setExpanded(new Set());
		setOnlyChanges(false);
		loadDirectory("");
		loadGit();
		return () => { latest.current.clear(); };
	}, [loadDirectory, loadGit]);
	useWindowRefresh(connected, refresh);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) refreshRef.current();
		wasRunning.current = running;
	}, [running]);
	return {
		directories, git, preview, expanded, onlyChanges, setOnlyChanges, refresh,
		openFile: loadPreview,
		closePreview: () => { latest.current.delete("preview"); setPreview(undefined); },
		toggleDirectory: (path: string, virtual = false) => {
			setExpanded((current) => {
				const next = new Set(current);
				if (next.has(path)) next.delete(path); else next.add(path);
				return next;
			});
			if (!expanded.has(path) && !virtual) loadDirectory(path);
		},
		collapseAll: () => setExpanded(new Set()),
	};
}
export type WorkbenchView = ReturnType<typeof useWorkbench>;
