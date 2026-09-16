import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiAction } from "../contract.ts";
import type { FilePreview, WorkbenchEvent, WorkbenchResult, WorkspaceEntry, WorkspaceGit } from "../workbench.ts";
import type { Send } from "./dialog.tsx";

export type Remote<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };
type Request = Extract<GuiAction, { action: "workspaceFiles" | "workspaceGit" | "previewFile" }>;

export function useWorkbench(cwd: string | undefined, connected: boolean, running: boolean, send: Send) {
	const [directories, setDirectories] = useState<Record<string, Remote<WorkspaceEntry[]>>>({});
	const [git, setGit] = useState<Remote<WorkspaceGit | null>>({ state: "loading" });
	const [preview, setPreview] = useState<{ path: string; result: Remote<FilePreview> }>();
	const [selection, setSelection] = useState(0);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [onlyChanges, setOnlyChanges] = useState(false);
	const pending = useRef(new Map<string, { key: string; receive: (result: WorkbenchResult) => void }>());
	const latest = useRef(new Map<string, string>());
	const scope = useRef(cwd);
	scope.current = cwd;
	const accept = useCallback((event: WorkbenchEvent) => {
		const request = pending.current.get(event.requestId);
		pending.current.delete(event.requestId);
		if (event.cwd === scope.current && request && latest.current.get(request.key) === event.requestId)
			request.receive(event.result);
	}, []);
	const request = useCallback((key: string, action: Request, receive: (result: WorkbenchResult) => void) => {
		const old = latest.current.get(key);
		if (old) pending.current.delete(old);
		latest.current.set(key, action.requestId);
		pending.current.set(action.requestId, { key, receive });
		void send(action).then((ok) => {
			if (!ok) accept({ type: "workbench", cwd: action.cwd, requestId: action.requestId,
				result: { kind: "error", message: "请求失败，请重新连接后刷新。" } });
		});
	}, [send, accept]);
	const loadDirectory = useCallback((path: string) => {
		if (!cwd || !connected) return;
		setDirectories((current) => current[path]?.state === "ready" ? current : ({ ...current, [path]: { state: "loading" } }));
		request(`directory:${path}`, { action: "workspaceFiles", cwd, path, requestId: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-") }, (result) => {
			if (result.kind === "directory") setDirectories((current) => ({ ...current, [path]: { state: "ready", value: result.entries } }));
			if (result.kind === "error") setDirectories((current) => ({ ...current, [path]: { state: "error", message: result.message } }));
		});
	}, [cwd, connected, request]);
	const loadGit = useCallback(() => {
		if (!cwd || !connected) return;
		request("git", { action: "workspaceGit", cwd, requestId: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-") }, (result) => {
			if (result.kind === "git") setGit({ state: "ready", value: result.git });
			if (result.kind === "error") setGit({ state: "error", message: result.message });
		});
	}, [cwd, connected, request]);
	const loadPreview = useCallback((path: string) => {
		if (!cwd || !connected) return;
		setPreview((current) => current?.path === path && current.result.state === "ready" ? current : { path, result: { state: "loading" } });
		request("preview", { action: "previewFile", cwd, path, requestId: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-") }, (result) => {
			if (result.kind === "preview") setPreview({ path, result: { state: "ready", value: result.preview } });
			if (result.kind === "error") setPreview({ path, result: { state: "error", message: result.message } });
		});
	}, [cwd, connected, request]);
	const refresh = useCallback(() => {
		loadDirectory("");
		for (const path of expanded) loadDirectory(path);
		loadGit();
		if (preview) loadPreview(preview.path);
	}, [loadDirectory, loadGit, loadPreview, expanded, preview?.path]);
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		pending.current.clear();
		latest.current.clear();
		setDirectories({});
		setGit({ state: "loading" });
		setPreview(undefined);
		setExpanded(new Set());
		setOnlyChanges(false);
		loadDirectory("");
		loadGit();
		return () => { pending.current.clear(); latest.current.clear(); };
	}, [cwd, connected, loadDirectory, loadGit]);
	useEffect(() => {
		if (!connected) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onFocus = () => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(timer);
			timer = setTimeout(() => refreshRef.current(), 150);
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [connected]);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) refreshRef.current();
		wasRunning.current = running;
	}, [running]);
	return {
		directories, git, preview, selection, expanded, onlyChanges, setOnlyChanges, accept, refresh,
		openFile: (path: string) => { loadPreview(path); setSelection((value) => value + 1); },
		closePreview: () => {
			const id = latest.current.get("preview");
			if (id) pending.current.delete(id);
			latest.current.delete("preview");
			setPreview(undefined);
		},
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
