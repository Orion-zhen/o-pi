import path from "node:path";

import type { DirectoryRef, ExistingRef } from "../../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../../contracts/result.js";
import type {
	IgnoreDiagnostic,
	VisibilityAnnotation,
	VisibilityDirectoryEntry,
	VisibilityIntent,
	VisibilityOperations,
	VisibilityPolicy,
} from "../../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../../kernel/namespace.js";
import { mapNativeError } from "../../kernel/native-error.js";
import { bindOperationContext } from "../../operation-context.js";
import type { NativeFileSystem } from "../../platform/node/native-filesystem.js";
import {
	buildVisibilityFingerprint,
	compileVisibilityRuleFiles,
	type CompiledVisibilityRules,
} from "./rule-compiler.js";
import {
	SOURCE_PRIORITY,
	pathDepth,
	rethrowVisibilityAbort,
	type CompiledVisibilityRuleSet,
	type VisibilityRuleFile,
} from "./model.js";
import { CompiledVisibilitySnapshot } from "./snapshot.js";
import type { GitTrackedFiles } from "./git-tracked-files.js";
import { nativeIdentity } from "../ref.js";

interface IncrementalVisibilityOptions {
	readonly generation: number;
	readonly root: string;
	readonly policy: VisibilityPolicy;
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly tracked: GitTrackedFiles;
	readonly caseInsensitive: boolean;
	readonly base: CompiledVisibilityRules;
	readonly initialRuleFiles: readonly VisibilityRuleFile[];
	readonly ownerSignal?: AbortSignal;
}

/** 按已枚举目录增量加载层级 ignore；每个 lease 内保持 snapshot 语义。 */
export class IncrementalVisibilityOperations implements VisibilityOperations {
	private readonly ruleSets: CompiledVisibilityRuleSet[];
	private readonly ruleFiles: VisibilityRuleFile[];
	private readonly diagnostics: IgnoreDiagnostic[];
	private readonly prepared = new Map<string, Promise<void>>();
	private readonly inspectedSubtrees = new Map<string, Promise<void>>();
	private evaluator: CompiledVisibilitySnapshot;

	constructor(private readonly options: IncrementalVisibilityOptions) {
		this.ruleSets = [...options.base.ruleSets];
		this.ruleFiles = [...options.initialRuleFiles];
		this.diagnostics = [...options.base.diagnostics];
		this.evaluator = this.createEvaluator();
	}

	get snapshot() {
		return {
			fingerprint: this.evaluator.fingerprint,
			diagnostics: this.evaluator.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	}

	async evaluate(
		ref: ExistingRef,
		intent: VisibilityIntent,
		context: FsOperationContext,
	): Promise<FsResult<VisibilityAnnotation>> {
		context = bindOperationContext(this.options.ownerSignal, context);
		const prepared = await this.prepareParentRules(ref, context);
		if (!prepared.ok) return prepared;
		const identity = nativeIdentity(this.options.namespace.bridge, ref);
		if (!identity.ok) return identity;
		const input = {
			path: ref.displayPath,
			absolutePath: identity.value.lexicalPath,
			...(ref.workspacePath === undefined ? {} : { workspacePath: ref.workspacePath }),
			kind: ref.kind,
			intent,
		};
		let decision = this.evaluator.evaluate(input);
		if (
			ref.kind === "directory"
			&& decision.ignored
			&& decision.prune
			&& canNestedRulesOverride(decision.matchedRule?.sourceType)
			&& shouldInspectSubtree(ref, this.options.policy)
		) {
			const inspected = await this.inspectIgnoredSubtree(ref, identity.value.nativePath, context);
			if (!inspected.ok) return inspected;
			decision = this.evaluator.evaluate(input);
		}
		const rule = decision.matchedRule;
		return fsSuccess({
			ignored: decision.ignored,
			prune: decision.prune,
			...(rule === undefined ? {} : {
				source: rule.sourcePath ?? rule.sourceType,
				rule: rule.pattern,
			}),
		});
	}

	async prepareDirectory(
		directory: DirectoryRef,
		entries: readonly VisibilityDirectoryEntry[],
		context: FsOperationContext,
	): Promise<FsResult<void>> {
		context = bindOperationContext(this.options.ownerSignal, context);
		if (context.signal?.aborted === true) return aborted(directory.displayPath);
		const key = workspaceDirectory(directory);
		if (key === undefined) return fsSuccess(undefined);
		const parents = await this.prepareParentRules(directory, context);
		if (!parents.ok) return parents;
		const identity = nativeIdentity(this.options.namespace.bridge, directory);
		if (!identity.ok) return identity;
		let pending = this.prepared.get(key);
		if (pending === undefined) {
			pending = this.loadRules(identity.value.nativePath, key, entries, context);
			this.prepared.set(key, pending);
		}
		try {
			await pending;
			return fsSuccess(undefined);
		} catch (error) {
			if (this.prepared.get(key) === pending) this.prepared.delete(key);
			return fsFailure(mapNativeError(error, directory.displayPath));
		}
	}

	private async prepareParentRules(ref: ExistingRef, context: FsOperationContext): Promise<FsResult<void>> {
		const workspacePath = ref.workspacePath;
		if (workspacePath === undefined || workspacePath === ".") return fsSuccess(undefined);
		const parent = path.posix.dirname(workspacePath.replaceAll("\\", "/"));
		if (parent === ".") return await this.ensureDirectoryPrepared(this.options.namespace.root, context);
		if (this.prepared.has(parent)) return await this.awaitPrepared(parent, ref.displayPath);

		let current = this.options.namespace.root;
		let currentPath = ".";
		for (const segment of parent.split("/")) {
			const prepared = await this.ensureDirectoryPrepared(current, context);
			if (!prepared.ok) return prepared;
			const resolved = await this.options.namespace.bridge.resolveChild(current, segment, context);
			if (!resolved.ok) {
				if (resolved.error.code === "aborted") return resolved;
				return fsSuccess(undefined);
			}
			if (resolved.value.ref.kind !== "directory") return fsSuccess(undefined);
			current = resolved.value.ref;
			currentPath = currentPath === "." ? segment : `${currentPath}/${segment}`;
		}
		if (currentPath !== parent) return fsSuccess(undefined);
		return await this.ensureDirectoryPrepared(current, context);
	}

	private async ensureDirectoryPrepared(
		directory: DirectoryRef,
		context: FsOperationContext,
	): Promise<FsResult<void>> {
		const key = workspaceDirectory(directory);
		if (key === undefined) return fsSuccess(undefined);
		if (this.prepared.has(key)) return await this.awaitPrepared(key, directory.displayPath);
		const identity = nativeIdentity(this.options.namespace.bridge, directory);
		if (!identity.ok) return identity;
		let entries;
		try {
			entries = await this.options.native.readdir(identity.value.nativePath, context);
		} catch (error) {
			try {
				rethrowVisibilityAbort(error);
			} catch (abortedError) {
				return fsFailure(mapNativeError(abortedError, directory.displayPath));
			}
			this.prepared.set(key, Promise.resolve());
			return fsSuccess(undefined);
		}
		return await this.prepareDirectory(directory, entries, context);
	}

	private async awaitPrepared(key: string, displayPath: string): Promise<FsResult<void>> {
		const pending = this.prepared.get(key);
		if (pending === undefined) return fsSuccess(undefined);
		try {
			await pending;
			return fsSuccess(undefined);
		} catch (error) {
			if (this.prepared.get(key) === pending) this.prepared.delete(key);
			return fsFailure(mapNativeError(error, displayPath));
		}
	}

	private async loadRules(
		nativeDirectory: string,
		baseDirectory: string,
		entries: readonly VisibilityDirectoryEntry[],
		context: FsOperationContext,
	): Promise<void> {
		const files: VisibilityRuleFile[] = [];
		for (const candidate of ruleCandidates(this.options.policy, baseDirectory, entries)) {
			const absolutePath = path.join(nativeDirectory, candidate.name);
			try {
				const metadata = await this.options.native.lstat(absolutePath, context);
				if (metadata.kind !== "file") continue;
				files.push({
					sourceType: candidate.sourceType,
					sourcePath: baseDirectory === "." ? candidate.name : `${baseDirectory}/${candidate.name}`,
					absolutePath,
					baseDirectory,
					priority: SOURCE_PRIORITY[candidate.sourceType],
					stamp: metadata.version,
				});
			} catch (error) {
				rethrowVisibilityAbort(error);
			}
		}
		if (files.length === 0) return;
		const compiled = await compileVisibilityRuleFiles(
			this.options.native,
			files,
			this.options.caseInsensitive,
			[],
			context,
		);
		this.ruleFiles.push(...files);
		this.ruleSets.push(...compiled.ruleSets);
		this.diagnostics.push(...compiled.diagnostics);
		this.evaluator = this.createEvaluator();
	}

	private async inspectIgnoredSubtree(
		root: DirectoryRef,
		nativeRoot: string,
		context: FsOperationContext,
	): Promise<FsResult<void>> {
		const workspaceRoot = workspaceDirectory(root);
		if (workspaceRoot === undefined) return fsSuccess(undefined);
		let pending = this.inspectedSubtrees.get(workspaceRoot);
		if (pending === undefined) {
			pending = this.scanRuleSubtree(nativeRoot, workspaceRoot, context);
			this.inspectedSubtrees.set(workspaceRoot, pending);
		}
		try {
			await pending;
			return fsSuccess(undefined);
		} catch (error) {
			if (this.inspectedSubtrees.get(workspaceRoot) === pending) this.inspectedSubtrees.delete(workspaceRoot);
			return fsFailure(mapNativeError(error, root.displayPath));
		}
	}

	private async scanRuleSubtree(
		nativeRoot: string,
		workspaceRoot: string,
		context: FsOperationContext,
	): Promise<void> {
		const pending: Array<{ readonly nativePath: string; readonly workspacePath: string }> = [{
			nativePath: nativeRoot,
			workspacePath: workspaceRoot,
		}];
		let head = 0;
		while (head < pending.length) {
			const batch = pending.slice(head, head + 8);
			head += batch.length;
			const children = await Promise.all(batch.map(async (directory) => {
				let entries: readonly VisibilityDirectoryEntry[];
				try {
					entries = await this.options.native.readdir(directory.nativePath, context);
				} catch (error) {
					rethrowVisibilityAbort(error);
					if (!this.prepared.has(directory.workspacePath)) {
						this.prepared.set(directory.workspacePath, Promise.resolve());
					}
					return [];
				}
				let prepared = this.prepared.get(directory.workspacePath);
				if (prepared === undefined) {
					prepared = this.loadRules(directory.nativePath, directory.workspacePath, entries, context);
					this.prepared.set(directory.workspacePath, prepared);
				}
				await prepared;
				return entries
					.filter((entry) => entry.kind === "directory")
					.map((entry) => ({
						nativePath: path.join(directory.nativePath, entry.name),
						workspacePath: `${directory.workspacePath}/${entry.name}`,
					}))
					.filter((entry) => !shouldSkipRuleDirectory(entry.workspacePath));
			}));
			for (const discovered of children) pending.push(...discovered);
		}
	}

	private createEvaluator(): CompiledVisibilitySnapshot {
		const sortedRuleSets = [...this.ruleSets].sort((left, right) =>
			left.priority - right.priority
			|| pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)
			|| (left.sourcePath ?? "").localeCompare(right.sourcePath ?? ""));
		const fingerprint = buildVisibilityFingerprint(
			this.options.policy,
			this.options.caseInsensitive,
			this.ruleFiles,
			this.options.tracked.paths,
			this.diagnostics,
		);
		return new CompiledVisibilitySnapshot(
			this.options.generation,
			fingerprint,
			this.options.root,
			sortedRuleSets,
			this.diagnostics,
			this.options.tracked.paths,
			this.options.policy,
			this.options.caseInsensitive,
		);
	}
}

function workspaceDirectory(directory: DirectoryRef): string | undefined {
	if (directory.workspacePath === undefined) return undefined;
	return directory.workspacePath.replaceAll("\\", "/").replace(/\/+$/u, "") || ".";
}

function ruleCandidates(
	policy: VisibilityPolicy,
	baseDirectory: string,
	entries: readonly VisibilityDirectoryEntry[],
): Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> {
	const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.name));
	const result: Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> = [];
	if (
		policy.ignore.gitignore.enabled
		&& (baseDirectory === "." || policy.ignore.gitignore.nested)
		&& files.has(".gitignore")
	) result.push({ name: ".gitignore", sourceType: "gitignore" });
	if (
		policy.ignore.piignore.enabled
		&& (baseDirectory === "." || policy.ignore.piignore.nested)
		&& files.has(policy.ignore.piignore.filename)
	) result.push({ name: policy.ignore.piignore.filename, sourceType: "piignore" });
	return result;
}

function aborted(pathname: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Operation aborted.", path: pathname });
}

function shouldInspectSubtree(directory: DirectoryRef, policy: VisibilityPolicy): boolean {
	return (policy.ignore.gitignore.enabled && policy.ignore.gitignore.nested
			|| policy.ignore.piignore.enabled && policy.ignore.piignore.nested)
		&& !shouldSkipRuleDirectory(workspaceDirectory(directory) ?? "");
}

function canNestedRulesOverride(sourceType: keyof typeof SOURCE_PRIORITY | undefined): boolean {
	return sourceType !== undefined && SOURCE_PRIORITY[sourceType] <= SOURCE_PRIORITY.piignore;
}

function shouldSkipRuleDirectory(relativeDirectory: string): boolean {
	const name = relativeDirectory.split("/").at(-1);
	return name === ".git" || name === "node_modules";
}
