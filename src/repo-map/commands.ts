import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	computeRepoMapActivation,
	isRepoMapAutoActivationDisabled,
	REPO_MAP_SESSION_ENTRY,
	type RepoMapActivation,
	type RepoMapActivationEntry,
	type RepoMapDeactivationEntry,
} from "./activation.js";
import { RepoMapError } from "./errors.js";
import { renderInitialization, renderStatus, renderUnavailableStatus } from "./renderer.js";
import type { DiscoveredRepoMap } from "./discovery.js";
import type { RepoMapProgress } from "./scanner.js";
import type { InitializeRepoMapInput, InitializeRepoMapResult } from "./service.js";
import type { RepoMapGeneration } from "./storage.js";

type RepoMapCommandApi = Pick<ExtensionAPI, "registerCommand" | "appendEntry">;
type RepoMapStatusContext = Pick<ExtensionCommandContext, "mode" | "sessionManager" | "ui">;

interface RepoMapAutoActivationApi {
	appendEntry<T>(customType: string, data: T): void;
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
}

export interface RepoMapAutoActivationDependencies {
	discover(cwd: string, signal?: AbortSignal): Promise<DiscoveredRepoMap | undefined>;
	initialize(input: InitializeRepoMapInput): Promise<InitializeRepoMapResult>;
	now(): Date;
}

export interface RepoMapCommandDependencies {
	initialize(input: InitializeRepoMapInput): Promise<InitializeRepoMapResult>;
	readActivated(activation: RepoMapActivation): Promise<RepoMapGeneration | undefined>;
	now(): Date;
}

export interface RepoMapCommandModuleImports {
	currentPointer(): Promise<{
		isActivatedGenerationCurrent: typeof import("./current-pointer.js").isActivatedGenerationCurrent;
	}>;
	service(): Promise<{
		initializeRepoMap: typeof import("./service.js").initializeRepoMap;
		readActivatedRepoMapState: typeof import("./service.js").readActivatedRepoMapState;
	}>;
}

const defaultModuleImports: RepoMapCommandModuleImports = {
	currentPointer: () => import("./current-pointer.js"),
	service: () => import("./service.js"),
};

const defaultDependencies = createRepoMapCommandDependencies();
const defaultAutoActivationDependencies: RepoMapAutoActivationDependencies = {
	async discover(cwd, signal) {
		return await (await import("./discovery.js")).discoverCurrentRepoMap(cwd, signal);
	},
	async initialize(input) {
		return await (await import("./service.js")).initializeRepoMap(input);
	},
	now: () => new Date(),
};

/** service 仅在首次构建或读取 active generation 时加载；并发调用共享加载，失败后允许重试。 */
export function createRepoMapCommandDependencies(
	imports: RepoMapCommandModuleImports = defaultModuleImports,
): RepoMapCommandDependencies {
	const loadCurrentPointer = createRetryableLoader(imports.currentPointer);
	const loadService = createRetryableLoader(imports.service);
	return {
		async initialize(input) {
			return await (await loadService()).initializeRepoMap(input);
		},
		async readActivated(activation) {
			if (!await (await loadCurrentPointer()).isActivatedGenerationCurrent(activation)) return undefined;
			return await (await loadService()).readActivatedRepoMapState(activation);
		},
		now: () => new Date(),
	};
}

export function registerRepoMapAutoActivation(
	pi: RepoMapAutoActivationApi,
	dependencies: Partial<RepoMapAutoActivationDependencies> = {},
): void {
	const deps = { ...defaultAutoActivationDependencies, ...dependencies };
	pi.on("session_start", async (_event, ctx) => {
		if (isRepoMapAutoActivationDisabled(ctx.sessionManager.getBranch())) {
			setRepoMapStatus(ctx, false);
			return;
		}
		safeSetStatus(ctx, "Repo Map: discovering");
		try {
			const discovered = await deps.discover(ctx.cwd, ctx.signal);
			if (discovered === undefined) {
				setRepoMapStatus(ctx, false);
				return;
			}
			let activation = discovered;
			if (discovered.needsRefresh) {
				safeSetStatus(ctx, "Repo Map: refreshing");
				const refreshed = await deps.initialize({
					cwd: discovered.root,
					mode: "refresh",
					...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
					onProgress(progress) {
						const status = renderProgressStatus(progress);
						if (status !== undefined) safeSetStatus(ctx, status);
					},
				});
				activation = {
					root: refreshed.metadata.repositoryRoot,
					mapId: refreshed.metadata.mapId,
					generation: refreshed.metadata.generation,
					freshness: refreshed.metadata.freshness,
					needsRefresh: false,
				};
			}
			appendActivationIfChanged(pi, ctx, deps.now, activation);
			setRepoMapStatus(ctx, true);
		} catch {
			setRepoMapStatus(ctx, isRepoMapActive(ctx));
		}
	});
}

export function registerRepoMapCommand(
	pi: RepoMapCommandApi,
	dependencies: Partial<RepoMapCommandDependencies> = {},
): void {
	const deps = { ...defaultDependencies, ...dependencies };
	pi.registerCommand("init", {
		description: "Initialize or inspect the session-local Repo Map",
		async handler(args, ctx) {
			const command = args.trim();
			if (command === "status") {
				await showStatus(deps, ctx);
				return;
			}
			if (command === "off") {
				turnOff(pi, deps, ctx);
				return;
			}
			if (command === "refresh" || command === "rebuild") {
				await initialize(pi, deps, ctx, command);
				return;
			}
			if (command !== "") {
				safeNotify(ctx, "usage: /init | /init status | /init refresh | /init rebuild | /init off", "warning");
				return;
			}
			await initialize(pi, deps, ctx);
		},
	});
}

async function initialize(
	pi: RepoMapCommandApi,
	deps: RepoMapCommandDependencies,
	ctx: ExtensionCommandContext,
	mode?: "refresh" | "rebuild",
): Promise<void> {
	let activeAfterOperation = false;
	try {
		safeSetStatus(ctx, "Repo Map: preparing");
		const result = await deps.initialize({
			cwd: ctx.cwd,
			...(mode !== undefined ? { mode } : {}),
			...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
			onProgress(progress) {
				const status = renderProgressStatus(progress);
				if (status !== undefined) safeSetStatus(ctx, status);
			},
		});
		const activation = computeRepoMapActivation(ctx.sessionManager.getBranch());
		if (
			activation === undefined
			|| activation.root !== result.metadata.repositoryRoot
			|| activation.mapId !== result.metadata.mapId
			|| activation.generation !== result.metadata.generation
		) {
			const entry: RepoMapActivationEntry = {
				kind: "activation",
				root: result.metadata.repositoryRoot,
				mapId: result.metadata.mapId,
				generation: result.metadata.generation,
				activatedAt: deps.now().toISOString(),
			};
			pi.appendEntry<RepoMapActivationEntry>(REPO_MAP_SESSION_ENTRY, entry);
		}
		activeAfterOperation = true;
		safeNotify(ctx, renderInitialization(result), "info");
	} catch (error) {
		if (ctx.mode === "tui") activeAfterOperation = isRepoMapActive(ctx);
		const aborted = error instanceof RepoMapError && error.code === "OPERATION_ABORTED";
		const message = error instanceof RepoMapError ? error.message : "Repo Map initialization failed.";
		safeNotify(ctx, message, aborted ? "warning" : "error");
	} finally {
		setRepoMapStatus(ctx, activeAfterOperation);
	}
}

async function showStatus(deps: RepoMapCommandDependencies, ctx: ExtensionCommandContext): Promise<void> {
	const activation = computeRepoMapActivation(ctx.sessionManager.getBranch());
	if (activation === undefined) {
		setRepoMapStatus(ctx, false);
		safeNotify(ctx, "Repo Map inactive", "info");
		return;
	}
	safeSetStatus(ctx, "Repo Map: checking status");
	try {
		const generation = await deps.readActivated(activation).catch(() => undefined);
		const metadata = generation === undefined
			? undefined
			: activation.freshness === undefined || generation.metadata.freshness === "stale" || generation.metadata.freshness === "unavailable"
				? generation.metadata
				: { ...generation.metadata, freshness: activation.freshness };
		safeNotify(ctx, metadata === undefined ? renderUnavailableStatus(activation) : renderStatus(metadata), "info");
	} finally {
		setRepoMapStatus(ctx, true);
	}
}

function appendActivationIfChanged(
	pi: Pick<RepoMapAutoActivationApi, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager">,
	now: () => Date,
	map: Pick<DiscoveredRepoMap, "root" | "mapId" | "generation" | "freshness">,
): void {
	const current = computeRepoMapActivation(ctx.sessionManager.getBranch());
	const freshness = map.freshness === "fresh" ? undefined : map.freshness;
	if (
		current?.root === map.root
		&& current.mapId === map.mapId
		&& current.generation === map.generation
		&& current.freshness === freshness
		&& current.diagnostic === undefined
	) return;
	const entry: RepoMapActivationEntry = {
		kind: "activation",
		root: map.root,
		mapId: map.mapId,
		generation: map.generation,
		activatedAt: now().toISOString(),
		...(freshness !== undefined ? { freshness } : {}),
	};
	pi.appendEntry<RepoMapActivationEntry>(REPO_MAP_SESSION_ENTRY, entry);
}

function turnOff(pi: RepoMapCommandApi, deps: RepoMapCommandDependencies, ctx: ExtensionCommandContext): void {
	const activation = computeRepoMapActivation(ctx.sessionManager.getBranch());
	if (activation !== undefined) {
		const entry: RepoMapDeactivationEntry = {
			kind: "deactivation",
			root: activation.root,
			deactivatedAt: deps.now().toISOString(),
		};
		pi.appendEntry<RepoMapDeactivationEntry>(REPO_MAP_SESSION_ENTRY, entry);
	}
	setRepoMapStatus(ctx, false);
	safeNotify(ctx, "Repo Map inactive", "info");
}

function isRepoMapActive(ctx: Pick<RepoMapStatusContext, "sessionManager">): boolean {
	return computeRepoMapActivation(ctx.sessionManager.getBranch()) !== undefined;
}

function setRepoMapStatus(ctx: Pick<RepoMapStatusContext, "mode" | "ui">, active: boolean): void {
	safeSetStatus(ctx, active ? "Repo Map: active" : "Repo Map: inactive");
}

function renderProgressStatus(progress: RepoMapProgress): string | undefined {
	const { completed, total } = progress;
	if (completed !== undefined && total !== undefined && completed > 1 && completed < total) {
		const updateInterval = Math.max(1, Math.ceil(total / 100));
		if (completed % updateInterval !== 0) return undefined;
	}
	const count = completed === undefined || total === undefined ? "" : ` ${completed}/${total}`;
	return `Repo Map: ${progress.phase}${count}`;
}

function safeNotify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Commands remain usable in hosts without an interactive UI.
	}
}

function safeSetStatus(ctx: Pick<ExtensionCommandContext, "mode" | "ui">, text: string): void {
	if (ctx.mode !== "tui") return;
	try {
		ctx.ui.setStatus("repo-map", text);
	} catch {
		// Progress is best effort.
	}
}

function createRetryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		if (pending !== undefined) return pending;
		const created = load();
		pending = created;
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
		return created;
	};
}
