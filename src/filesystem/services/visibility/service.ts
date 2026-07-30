import path from "node:path";

import type { FsOperationContext } from "../../contracts/result.js";
import type {
	VisibilityPolicy,
	VisibilityService,
	VisibilitySnapshot,
} from "../../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../../kernel/namespace.js";
import { NativeFileSystemError, NodeNativeFileSystem, type NativeFileSystem } from "../../platform/node/native-filesystem.js";
import { GitTrackedFilesLoader } from "./git-tracked-files.js";
import {
	SOURCE_PRIORITY,
	rethrowVisibilityAbort,
	type VisibilityRuleFile,
	type VisibilitySnapshotCacheEntry,
} from "./model.js";
import {
	buildVisibilityFingerprint,
	compileBaseVisibilityRules,
	compileVisibilityRuleFiles,
	compileVisibilityRules,
	resolveCaseInsensitive,
} from "./rule-compiler.js";
import { discoverVisibilityRules, visibilityStampsUnchanged } from "./rule-discovery.js";
import { SharedBuild } from "./shared-build.js";
import { CompiledVisibilitySnapshot } from "./snapshot.js";
import { IncrementalVisibilityOperations } from "./incremental-operations.js";

interface VisibilityCacheEpoch {
	readonly generation: number;
	readonly workspace: number;
}

let nextGeneration = 1;

/** Owns incremental runtime evaluators plus immutable diagnostic snapshots and shared Git state. */
export class WorkspaceVisibilityService implements VisibilityService {
	private readonly cache = new Map<string, VisibilitySnapshotCacheEntry>();
	private readonly pending = new Map<string, SharedBuild<VisibilitySnapshot>>();
	private readonly epochs = new Map<string, number>();
	private readonly canonicalRoots = new Map<string, string>();
	private readonly native: NativeFileSystem;
	private readonly git: GitTrackedFilesLoader;
	private generation = 0;

	constructor(native: NativeFileSystem = new NodeNativeFileSystem()) {
		this.native = native;
		this.git = new GitTrackedFilesLoader(native);
	}

	async createSnapshot(
		root: string,
		policy: VisibilityPolicy,
		context: FsOperationContext = {},
	): Promise<VisibilitySnapshot> {
		const canonicalRoot = await this.native.realpath(root, context);
		this.canonicalRoots.set(path.resolve(root), canonicalRoot);
		if (!this.epochs.has(canonicalRoot)) this.epochs.set(canonicalRoot, 0);
		const pendingKey = `${canonicalRoot}:${policy.fingerprint}`;
		let pending = this.pending.get(pendingKey);
		if (pending === undefined) {
			const epoch = { generation: this.generation, workspace: this.epochs.get(canonicalRoot) ?? 0 };
			const created = new SharedBuild(
				async (signal) => await this.buildSnapshot(canonicalRoot, policy, epoch, signal),
				{
					createConsumerAbort: () => new NativeFileSystemError("aborted", "visibility", canonicalRoot),
					onSettled: () => {
						if (this.pending.get(pendingKey) === created) this.pending.delete(pendingKey);
					},
				},
			);
			this.pending.set(pendingKey, created);
			pending = created;
		}
		return await pending.consume(context.signal);
	}

	async createOperations(
		root: string,
		policy: VisibilityPolicy,
		namespace: WorkspaceNamespaceKernel,
		context: FsOperationContext = {},
		ownerSignal?: AbortSignal,
	): Promise<IncrementalVisibilityOperations> {
		const tracked = await this.git.load(root, context.signal);
		const caseInsensitive = resolveCaseInsensitive(policy.ignore, tracked.ignoreCase);
		const initialRuleFiles = await this.directRuleFiles(root, policy, context);
		const initialRules = await compileVisibilityRuleFiles(
			this.native,
			initialRuleFiles,
			caseInsensitive,
			[],
			context,
		);
		const base = compileBaseVisibilityRules(policy.ignore, caseInsensitive, initialRules.diagnostics);
		const generation = nextGeneration;
		nextGeneration += 1;
		return new IncrementalVisibilityOperations({
			generation,
			root,
			policy,
			native: this.native,
			namespace,
			tracked,
			caseInsensitive,
			base: { ruleSets: [...base.ruleSets, ...initialRules.ruleSets], diagnostics: initialRules.diagnostics },
			initialRuleFiles,
			...(ownerSignal === undefined ? {} : { ownerSignal }),
		});
	}

	invalidate(root?: string): void {
		if (root === undefined) {
			this.generation += 1;
			this.cache.clear();
			for (const pending of this.pending.values()) pending.abort();
			this.pending.clear();
			this.epochs.clear();
			this.canonicalRoots.clear();
			this.git.clear();
			return;
		}
		const canonicalRoot = this.canonicalRoots.get(path.resolve(root)) ?? path.resolve(root);
		this.epochs.set(canonicalRoot, (this.epochs.get(canonicalRoot) ?? 0) + 1);
		for (const key of this.cache.keys()) {
			if (key.startsWith(`${canonicalRoot}:`)) this.cache.delete(key);
		}
		for (const [key, pending] of this.pending) {
			if (!key.startsWith(`${canonicalRoot}:`)) continue;
			pending.abort();
			this.pending.delete(key);
		}
	}

	private async buildSnapshot(
		root: string,
		policy: VisibilityPolicy,
		epoch: VisibilityCacheEpoch,
		signal?: AbortSignal,
	): Promise<VisibilitySnapshot> {
		const context = signal === undefined ? {} : { signal };
		const tracked = await this.git.load(root, signal);
		const caseInsensitive = resolveCaseInsensitive(policy.ignore, tracked.ignoreCase);
		const cacheKey = `${root}:${policy.fingerprint}:${caseInsensitive}`;
		const cached = this.cache.get(cacheKey);
		if (cached?.trackedFingerprint === tracked.fingerprint
			&& await visibilityStampsUnchanged(this.native, cached.directories, cached.ruleFiles, signal)) {
			return cached.snapshot;
		}

		const discovery = await discoverVisibilityRules(this.native, root, policy.ignore, context);
		const compiled = await compileVisibilityRules(
			this.native,
			discovery.ruleFiles,
			policy.ignore,
			caseInsensitive,
			discovery.diagnostics,
			context,
		);
		const fingerprint = buildVisibilityFingerprint(
			policy,
			caseInsensitive,
			discovery.ruleFiles,
			tracked.paths,
			compiled.diagnostics,
		);
		if (cached?.fingerprint === fingerprint) {
			if (this.isCurrent(root, epoch)) {
				this.cache.set(cacheKey, {
					fingerprint,
					snapshot: cached.snapshot,
					directories: discovery.directories,
					ruleFiles: discovery.ruleFiles,
					trackedFingerprint: tracked.fingerprint,
				});
			}
			return cached.snapshot;
		}

		const snapshot = new CompiledVisibilitySnapshot(
			nextGeneration,
			fingerprint,
			root,
			compiled.ruleSets,
			compiled.diagnostics,
			tracked.paths,
			policy,
			caseInsensitive,
		);
		nextGeneration += 1;
		if (this.isCurrent(root, epoch)) {
			this.cache.set(cacheKey, {
				fingerprint,
				snapshot,
				directories: discovery.directories,
				ruleFiles: discovery.ruleFiles,
				trackedFingerprint: tracked.fingerprint,
			});
		}
		return snapshot;
	}

	private isCurrent(root: string, epoch: VisibilityCacheEpoch): boolean {
		return this.generation === epoch.generation && (this.epochs.get(root) ?? 0) === epoch.workspace;
	}

	private async directRuleFiles(
		root: string,
		policy: VisibilityPolicy,
		context: FsOperationContext,
	): Promise<VisibilityRuleFile[]> {
		if (!policy.ignore.gitInfoExclude) return [];
		const sourcePath = ".git/info/exclude";
		const absolutePath = path.join(root, ".git", "info", "exclude");
		try {
			const metadata = await this.native.lstat(absolutePath, context);
			if (metadata.kind !== "file") return [];
			return [{
				sourceType: "git-info-exclude",
				sourcePath,
				absolutePath,
				baseDirectory: ".",
				priority: SOURCE_PRIORITY["git-info-exclude"],
				stamp: metadata.version,
			}];
		} catch (error) {
			rethrowVisibilityAbort(error);
			return [];
		}
	}
}

export const defaultVisibilityService: VisibilityService = new WorkspaceVisibilityService();

export async function createVisibilitySnapshot(
	root: string,
	policy: VisibilityPolicy,
	context: FsOperationContext = {},
): Promise<VisibilitySnapshot> {
	return await defaultVisibilityService.createSnapshot(root, policy, context);
}
