import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import { computeRepoMapActivation, REPO_MAP_SESSION_ENTRY, type RepoMapActivationEntry } from "../../repo-map/activation.js";
import type { RepoMapFileToolQuery, RepoMapMutationResult, RepoMapReadContext } from "../../repo-map/file-tool-query.js";
import type { RepoMapImpactResult } from "../../repo-map/impact.js";

export interface RepoMapRuntimeModule {
	createRepoMapFileToolQuery: typeof import("../../repo-map/file-tool-query.js").createRepoMapFileToolQuery;
	formatRepoMapImpact: typeof import("../../repo-map/tool-output.js").formatRepoMapImpact;
	formatRepoMapReadContext: typeof import("../../repo-map/tool-output.js").formatRepoMapReadContext;
}

export interface LazyRepoMap {
	query: RepoMapFileToolQuery;
	formatReadContext(context: RepoMapReadContext): Promise<string | undefined>;
	formatImpact(impact: RepoMapImpactResult | undefined): Promise<string | undefined>;
	syncMutation(
		result: { path: string; firstChangedLine?: number; repo_map?: RepoMapMutationResult },
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<void>;
}

interface LazyRepoMapOptions {
	getBranch(): SessionEntry[];
	appendEntry(entry: RepoMapActivationEntry): void;
	load(): Promise<RepoMapRuntimeModule>;
}

/** 未激活时只扫描 session entries，不加载 Repo Map query、storage 或 tokenizer。 */
export function createLazyRepoMap(options: LazyRepoMapOptions): LazyRepoMap {
	let activeQuery: RepoMapFileToolQuery | undefined;
	const formattedReadContexts = new WeakMap<RepoMapReadContext, Promise<string | undefined>>();
	const getActiveQuery = async (): Promise<RepoMapFileToolQuery | undefined> => {
		if (computeRepoMapActivation(options.getBranch()) === undefined) return undefined;
		if (activeQuery !== undefined) return activeQuery;
		const runtime = await options.load();
		activeQuery = runtime.createRepoMapFileToolQuery(options.getBranch, {
			appendActivation(entry) {
				options.appendEntry(entry);
			},
		});
		return activeQuery;
	};

	const query: RepoMapFileToolQuery = {
		async query(input) {
			return (await getActiveQuery())?.query(input);
		},
		async readContext(input) {
			return (await getActiveQuery())?.readContext(input);
		},
		async syncMutation(input) {
			return (await getActiveQuery())?.syncMutation(input);
		},
	};

	async function renderReadContext(context: RepoMapReadContext): Promise<string | undefined> {
		try {
			return (await options.load()).formatRepoMapReadContext(context);
		} catch {
			return undefined;
		}
	}

	return {
		query,
		formatReadContext(context) {
			const cached = formattedReadContexts.get(context);
			if (cached !== undefined) return cached;
			const pending = renderReadContext(context);
			formattedReadContexts.set(context, pending);
			return pending;
		},
		async formatImpact(impact) {
			if (impact === undefined) return undefined;
			try {
				return (await options.load()).formatRepoMapImpact(impact);
			} catch {
				return undefined;
			}
		},
		async syncMutation(result, cwd, signal) {
			try {
				const update = await query.syncMutation({
					requestedPath: path.resolve(cwd, result.path),
					...(result.firstChangedLine !== undefined ? { changedLine: result.firstChangedLine } : {}),
					...(signal !== undefined ? { signal } : {}),
				});
				if (update !== undefined) result.repo_map = update;
			} catch {
				// Repo Map 是非阻塞增强；文件 mutation 已成功。
			}
		},
	};
}

export function appendRepoMapEntry(pi: Pick<ExtensionAPI, "appendEntry">, entry: RepoMapActivationEntry): void {
	pi.appendEntry<RepoMapActivationEntry>(REPO_MAP_SESSION_ENTRY, entry);
}
