import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "../../../shared/workspace.ts";
import type { Remote } from "@/connection/use-remote.ts";

export type WorkspacePane = "sessions" | "files";

interface WorkbenchState {
	directories: Record<string, Remote<WorkspaceEntry[]>>;
	git: Remote<WorkspaceGit | null>;
	preview: { path: string; result: Remote<FilePreview> } | undefined;
	expanded: Set<string>;
	onlyChanges: boolean;
	filesOpen: boolean;
	pane: WorkspacePane;
}

/** 每个工作区独立持有展示状态和在途读取，不向后继工作区写入。 */
export class WorkspaceState {
	private state: WorkbenchState = {
		directories: {}, git: { state: "loading" }, preview: undefined, expanded: new Set(),
		onlyChanges: false, filesOpen: true, pane: "sessions",
	};
	private listeners = new Set<() => void>();
	private pending = new Map<string, { dirty: boolean }>();
	read = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	update(change: Partial<WorkbenchState>): void {
		this.state = { ...this.state, ...change };
		for (const listener of this.listeners) listener();
	}
	setDirectory(path: string, result: Remote<WorkspaceEntry[]>): void {
		this.update({ directories: { ...this.state.directories, [path]: result } });
	}
	cancel(): void { this.pending.clear(); }
	selectPreview(path: string | undefined): void {
		for (const key of this.pending.keys()) if (key.startsWith("preview:") && key !== `preview:${path}`) this.pending.delete(key);
		if (path === undefined) this.update({ preview: undefined });
		else if (this.state.preview?.path !== path || this.state.preview.result.state !== "ready") this.update({ preview: { path, result: { state: "loading" } } });
	}

	/** 同一路径串行读取，期间的刷新合并为一次后续读取。 */
	async load<T>(key: string, task: () => Promise<T>, receive: (result: Remote<T>) => void): Promise<void> {
		const previous = this.pending.get(key);
		if (previous) { previous.dirty = true; return; }
		const request = { dirty: true };
		this.pending.set(key, request);
		while (request.dirty && this.pending.get(key) === request) {
			request.dirty = false;
			let result: Remote<T>;
			try { result = { state: "ready", value: await task() }; }
			catch (error) { result = { state: "error", message: error instanceof Error ? error.message : String(error) }; }
			if (this.pending.get(key) === request && !request.dirty) {
				this.pending.delete(key);
				receive(result);
			}
		}
	}
}
