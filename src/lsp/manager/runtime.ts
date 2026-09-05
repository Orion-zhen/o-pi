import path from "node:path";

import { loadLspConfig, resolveLspConfigPath } from "../config/loader.js";
import { DiagnosticsLedger } from "../diagnostics/ledger.js";
import type { LspStatus } from "../types.js";
import { LspWorkspace } from "./workspace.js";

type WorkspaceLoad =
	| { workspace: LspWorkspace }
	| { error: string; configPath: string };

/** 进程内共享工作区，reload 阻止新操作并等待活动操作结束。 */
export class LspManagerRuntime {
	private readonly workspaces = new Map<string, Promise<WorkspaceLoad>>();
	private reloadPromise: Promise<void> | undefined;
	private activeClientOperations = 0;
	private clientDrainResolve: (() => void) | undefined;
	readonly diagnostics = new DiagnosticsLedger();

	async status(root = process.cwd()): Promise<LspStatus> {
		const loaded = await this.loadWorkspace(root);
		return "workspace" in loaded ? loaded.workspace.status() : {
			enabled: false,
			config_path: loaded.configPath,
			last_error: loaded.error,
			servers: [],
		};
	}

	async workspace(root: string): Promise<LspWorkspace | undefined> {
		const loaded = await this.loadWorkspace(root);
		return "workspace" in loaded && loaded.workspace.enabled ? loaded.workspace : undefined;
	}

	async reload(): Promise<void> {
		if (this.reloadPromise !== undefined) return this.reloadPromise;
		const pending = Promise.resolve().then(() => this.performReload());
		this.reloadPromise = pending;
		try {
			await pending;
		} finally {
			if (this.reloadPromise === pending) this.reloadPromise = undefined;
		}
	}

	async withClientOperation<T>(operation: () => Promise<T>): Promise<T> {
		await this.admitClientOperation();
		try {
			return await operation();
		} finally {
			this.activeClientOperations -= 1;
			if (this.activeClientOperations === 0) {
				this.clientDrainResolve?.();
				this.clientDrainResolve = undefined;
			}
		}
	}

	private loadWorkspace(root: string): Promise<WorkspaceLoad> {
		const normalizedRoot = path.resolve(root);
		let pending = this.workspaces.get(normalizedRoot);
		if (pending === undefined) {
			pending = loadLspConfig(normalizedRoot).then(
				(loaded): WorkspaceLoad => ({ workspace: new LspWorkspace(normalizedRoot, loaded, this.diagnostics) }),
				(error: unknown): WorkspaceLoad => ({
					error: error instanceof Error ? error.message : String(error),
					configPath: resolveLspConfigPath(),
				}),
			);
			this.workspaces.set(normalizedRoot, pending);
		}
		return pending;
	}

	private async performReload(): Promise<void> {
		if (this.activeClientOperations > 0) {
			await new Promise<void>((resolve) => { this.clientDrainResolve = resolve; });
		}
		await Promise.all([...this.workspaces.values()].map(async (pending) => {
			const loaded = await pending;
			if ("workspace" in loaded) await loaded.workspace.shutdown();
		}));
		this.workspaces.clear();
		this.diagnostics.clear();
	}

	private async admitClientOperation(): Promise<void> {
		while (true) {
			const pending = this.reloadPromise;
			if (pending === undefined) {
				this.activeClientOperations += 1;
				return;
			}
			await pending;
		}
	}
}
