import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import { computeRepoMapActivation, REPO_MAP_SESSION_ENTRY, type RepoMapActivationEntry } from "../../repo-map/runtime/activation.js";
import type { RepoMapFileToolQuery, RepoMapReadContext } from "../../repo-map/query/file-tool-query.js";
import type { RepoMapImpactResult } from "../../repo-map/query/impact.js";
import type { RepoMapOutputConfig } from "../../repo-map/config/output-config.js";

export interface RepoMapRuntimeModule {
	createRepoMapFileToolQuery: typeof import("../../repo-map/query/file-tool-query.js").createRepoMapFileToolQuery;
	loadRepoMapOutputConfig(): Promise<RepoMapOutputConfig>;
	formatRepoMapImpact: typeof import("../../repo-map/runtime/tool-output.js").formatRepoMapImpact;
	formatRepoMapReadContext: typeof import("../../repo-map/runtime/tool-output.js").formatRepoMapReadContext;
}

export interface RepoMapToolPorts {
	query: RepoMapFileToolQuery;
	formatReadContext(context: RepoMapReadContext): Promise<string | undefined>;
	formatImpact(impact: RepoMapImpactResult | undefined): Promise<string | undefined>;
}

export interface LazyRepoMap extends RepoMapToolPorts {
	dispose(): void;
}

interface LazyRepoMapOptions {
	getBranch(): SessionEntry[];
	appendEntry(entry: RepoMapActivationEntry): void;
	load(): Promise<RepoMapRuntimeModule>;
}

/** 未激活时只扫描 session entries，不加载 Repo Map query、storage 或 tokenizer。 */
export function createLazyRepoMap(options: LazyRepoMapOptions): LazyRepoMap {
	let activeQuery: RepoMapFileToolQuery | undefined;
	let outputRuntime: Promise<{ runtime: RepoMapRuntimeModule; config: RepoMapOutputConfig }> | undefined;
	let disposed = false;
	const formattedReadContexts = new WeakMap<RepoMapReadContext, Promise<string | undefined>>();
	const getActiveQuery = async (): Promise<RepoMapFileToolQuery | undefined> => {
		if (disposed || computeRepoMapActivation(options.getBranch()) === undefined) return undefined;
		if (activeQuery !== undefined) return activeQuery;
		const runtime = await options.load();
		if (disposed) return undefined;
		activeQuery = runtime.createRepoMapFileToolQuery(options.getBranch, {
			appendActivation(entry) {
				options.appendEntry(entry);
			},
		});
		return activeQuery;
	};
	const getOutputRuntime = (): Promise<{ runtime: RepoMapRuntimeModule; config: RepoMapOutputConfig }> => {
		if (disposed) return Promise.reject(new Error("Repo Map adapter is disposed."));
		if (outputRuntime !== undefined) return outputRuntime;
		const created = (async () => {
			const runtime = await options.load();
			if (disposed) throw new Error("Repo Map adapter is disposed.");
			const config = await runtime.loadRepoMapOutputConfig();
			if (disposed) throw new Error("Repo Map adapter is disposed.");
			return { runtime, config };
		})();
		outputRuntime = created;
		void created.catch(() => {
			if (outputRuntime === created) outputRuntime = undefined;
		});
		return created;
	};

	const query: RepoMapFileToolQuery = {
		async query(input) {
			return (await getActiveQuery())?.query(input);
		},
		async readContext(input) {
			if (!input.partial && !input.truncated) return undefined;
			const active = await getActiveQuery();
			if (active === undefined) return undefined;
			const { config } = await getOutputRuntime();
			return active.readContext({
				...input,
				suggestedReadLimit: input.suggestedReadLimit ?? config.read_suggestion_limit,
				suggestedTestLimit: input.suggestedTestLimit ?? config.read_test_limit,
			});
		},
		async syncMutation(input) {
			return (await getActiveQuery())?.syncMutation(input);
		},
		async syncMutations(inputs) {
			const active = await getActiveQuery();
			if (active === undefined) return inputs.map(() => undefined);
			if (active.syncMutations !== undefined) return await active.syncMutations(inputs);
			return await Promise.all(inputs.map((input) => active.syncMutation(input)));
		},
	};

	async function renderReadContext(context: RepoMapReadContext): Promise<string | undefined> {
		try {
			const { runtime, config } = await getOutputRuntime();
			return runtime.formatRepoMapReadContext(context, config);
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
			if (disposed || impact === undefined) return undefined;
			try {
				const { runtime, config } = await getOutputRuntime();
				return runtime.formatRepoMapImpact(impact, config);
			} catch {
				return undefined;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			activeQuery = undefined;
			outputRuntime = undefined;
		},
	};
}

export function appendRepoMapEntry(pi: Pick<ExtensionAPI, "appendEntry">, entry: RepoMapActivationEntry): void {
	pi.appendEntry<RepoMapActivationEntry>(REPO_MAP_SESSION_ENTRY, entry);
}
