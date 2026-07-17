import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	computeRepoMapActivation,
	REPO_MAP_SESSION_ENTRY,
	type RepoMapActivationEntry,
	type RepoMapDeactivationEntry,
} from "./activation.js";
import { RepoMapError } from "./errors.js";
import { renderInitialization, renderStatus, renderUnavailableStatus } from "./renderer.js";
import { initializeRepoMap, readActivatedRepoMapState, type InitializeRepoMapInput, type InitializeRepoMapResult } from "./service.js";
import type { RepoMapGeneration } from "./storage.js";

type RepoMapCommandApi = Pick<ExtensionAPI, "registerCommand" | "appendEntry">;

export interface RepoMapCommandDependencies {
	initialize(input: InitializeRepoMapInput): Promise<InitializeRepoMapResult>;
	readActivated(activation: { root: string; mapId: string; generation: string }): Promise<RepoMapGeneration | undefined>;
	now(): Date;
}

const defaultDependencies: RepoMapCommandDependencies = {
	initialize: initializeRepoMap,
	readActivated: readActivatedRepoMapState,
	now: () => new Date(),
};

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
	try {
		const result = await deps.initialize({
			cwd: ctx.cwd,
			...(mode !== undefined ? { mode } : {}),
			...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
			onProgress(progress) {
				const count = progress.completed === undefined || progress.total === undefined ? "" : ` ${progress.completed}/${progress.total}`;
				safeSetStatus(ctx, `Repo Map: ${progress.phase}${count}`);
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
		safeNotify(ctx, renderInitialization(result), "info");
	} catch (error) {
		const aborted = error instanceof RepoMapError && error.code === "OPERATION_ABORTED";
		const message = error instanceof RepoMapError ? error.message : "Repo Map initialization failed.";
		safeNotify(ctx, message, aborted ? "warning" : "error");
	} finally {
		safeSetStatus(ctx, undefined);
	}
}

async function showStatus(deps: RepoMapCommandDependencies, ctx: ExtensionCommandContext): Promise<void> {
	const activation = computeRepoMapActivation(ctx.sessionManager.getBranch());
	if (activation === undefined) {
		safeNotify(ctx, "Repo Map inactive", "info");
		return;
	}
	const generation = await deps.readActivated(activation).catch(() => undefined);
	const metadata = generation === undefined
		? undefined
		: activation.freshness === undefined || generation.metadata.freshness === "stale" || generation.metadata.freshness === "unavailable"
			? generation.metadata
			: { ...generation.metadata, freshness: activation.freshness };
	safeNotify(ctx, metadata === undefined ? renderUnavailableStatus(activation) : renderStatus(metadata), "info");
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
	safeNotify(ctx, "Repo Map inactive", "info");
}

function safeNotify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Commands remain usable in hosts without an interactive UI.
	}
}

function safeSetStatus(ctx: ExtensionCommandContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus("repo-map", text);
	} catch {
		// Progress is best effort.
	}
}
