import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useSyncExternalStore } from "react";
import type { Query, WorkspaceQuery } from "../../../shared/protocol/queries.ts";
import { useWindowRefresh } from "@/connection/use-window-refresh.ts";
import { WorkspaceState, type WorkspacePane } from "./workspace-state.ts";

function visibleExpanded(expanded: Set<string>) {
	const visible = new Map<string, boolean>();
	const check = (path: string): boolean => {
		const known = visible.get(path);
		if (known !== undefined) return known;
		const separator = path.lastIndexOf("/");
		const parent = path.slice(0, separator);
		const value = separator < 0 || expanded.has(parent) && check(parent);
		visible.set(path, value);
		return value;
	};
	return [...expanded].filter(check);
}

export function useWorkbench(cwd: string, enabled: boolean, running: boolean, query: Query<WorkspaceQuery>) {
	const scope = useMemo(() => new WorkspaceState(), [cwd]);
	const state = useSyncExternalStore(scope.subscribe, scope.read);
	const loadDirectory = useCallback((path: string) => {
		if (!enabled) return;
		if (scope.read().directories[path]?.state !== "ready") scope.setDirectory(path, { state: "loading" });
		void scope.load(`directory:${path}`, () => query({ query: "workspaceFiles", cwd, path }), (result) => scope.setDirectory(path, result));
	}, [scope, cwd, enabled, query]);
	const loadGit = useCallback(() => {
		if (enabled) void scope.load("git", () => query({ query: "workspaceGit", cwd }), (git) => scope.update({ git }));
	}, [scope, cwd, enabled, query]);
	const openFile = useCallback((path: string) => {
		if (!enabled) return;
		scope.selectPreview(path);
		void scope.load(`preview:${path}`, () => query({ query: "previewFile", cwd, path }), (result) => scope.update({ preview: { path, result } }));
	}, [scope, cwd, enabled, query]);
	const refresh = useCallback(() => {
		const { expanded, directories, preview } = scope.read();
		loadDirectory("");
		for (const path of visibleExpanded(expanded)) if (directories[path]) loadDirectory(path);
		loadGit();
		if (preview) openFile(preview.path);
	}, [scope, loadDirectory, loadGit, openFile]);
	useEffect(() => {
		refresh();
		return () => scope.cancel();
	}, [scope, refresh]);
	useWindowRefresh(enabled, refresh);
	const onRefresh = useEffectEvent(refresh);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) onRefresh();
		wasRunning.current = running;
	}, [running]);
	const closePreview = useCallback(() => scope.selectPreview(undefined), [scope]);
	const toggleDirectory = useCallback((path: string, virtual = false) => {
		const { expanded, directories } = scope.read();
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path); else next.add(path);
		scope.update({ expanded: next });
		if (!expanded.has(path)) {
			if (!virtual) loadDirectory(path);
			for (const child of visibleExpanded(next)) if (child.startsWith(`${path}/`) && directories[child]) loadDirectory(child);
		}
	}, [scope, loadDirectory]);
	const controls = useMemo(() => ({
		setOnlyChanges: (onlyChanges: boolean) => scope.update({ onlyChanges }),
		setFilesOpen: (filesOpen: boolean) => scope.update({ filesOpen }),
		setPane: (pane: WorkspacePane) => scope.update({ pane }),
		collapseAll: () => scope.update({ expanded: new Set() }),
	}), [scope]);
	return useMemo(() => ({ ...state, ...controls, refresh, openFile, closePreview, toggleDirectory }),
		[state, controls, refresh, openFile, closePreview, toggleDirectory]);
}
export type WorkbenchView = ReturnType<typeof useWorkbench>;
