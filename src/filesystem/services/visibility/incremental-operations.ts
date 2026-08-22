import path from "node:path";

import type { DirectoryRef, ExistingRef } from "../../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../../contracts/result.js";
import type {
	VisibilityAnnotation,
	VisibilityDirectoryEntry,
	VisibilityIntent,
	VisibilityOperations,
	VisibilityPolicy,
} from "../../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../../kernel/namespace.js";
import { mapNativeError } from "../../kernel/native-error.js";
import type { NativeFileSystem } from "../../platform/node/native-filesystem.js";
import { nativeIdentity } from "../ref.js";
import { VisibilityEvaluator } from "./evaluator.js";
import type { GitTrackedFiles } from "./git-tracked-files.js";
import {
	pathDepth,
	rethrowVisibilityAbort,
	type CompiledVisibilityRuleSet,
	type VisibilityRuleFile,
} from "./model.js";
import {
	buildVisibilityFingerprint,
	compileVisibilityRuleFiles,
	type CompiledVisibilityRules,
} from "./rule-compiler.js";

interface IncrementalVisibilityOptions {
	readonly root: string;
	readonly policy: VisibilityPolicy;
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly tracked: GitTrackedFiles;
	readonly caseInsensitive: boolean;
	readonly base: CompiledVisibilityRules;
	readonly context: FsOperationContext;
}

/** 按已枚举目录增量加载层级 ignore。 */
export class IncrementalVisibilityOperations implements VisibilityOperations {
	private readonly ruleSets: CompiledVisibilityRuleSet[];
	private readonly ruleFiles: VisibilityRuleFile[] = [];
	private readonly prepared = new Map<string, Promise<void>>();
	private evaluator: VisibilityEvaluator;
	private currentFingerprint: string;

	constructor(private readonly options: IncrementalVisibilityOptions) {
		this.ruleSets = [...options.base.ruleSets];
		this.evaluator = this.createEvaluator();
		this.currentFingerprint = this.createFingerprint();
	}

	get fingerprint(): string {
		return this.currentFingerprint;
	}

	async evaluate(
		ref: ExistingRef,
		intent: VisibilityIntent,
	): Promise<FsResult<VisibilityAnnotation>> {
		const context = this.options.context;
		const prepared = await this.prepareParentRules(ref, context);
		if (!prepared.ok) return prepared;
		const identity = nativeIdentity(this.options.namespace.bridge, ref);
		if (!identity.ok) return identity;
		const decision = this.evaluator.evaluate({
			path: ref.displayPath,
			absolutePath: identity.value.lexicalPath,
			...(ref.workspacePath === undefined ? {} : { workspacePath: ref.workspacePath }),
			kind: ref.kind,
			intent,
		});
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
	): Promise<FsResult<void>> {
		const context = this.options.context;
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
			const resolved = await this.options.namespace.bridge.resolveChild(current, segment);
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
		return await this.prepareDirectory(directory, entries);
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
		for (const candidate of ruleCandidates(this.options.policy, entries)) {
			const absolutePath = path.join(nativeDirectory, candidate.name);
			try {
				const metadata = await this.options.native.lstat(absolutePath, context);
				if (metadata.kind !== "file") continue;
				files.push({
					sourceType: candidate.sourceType,
					sourcePath: baseDirectory === "." ? candidate.name : `${baseDirectory}/${candidate.name}`,
					absolutePath,
					baseDirectory,
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
			context,
		);
		this.ruleFiles.push(...files);
		this.ruleSets.push(...compiled.ruleSets);
		this.evaluator = this.createEvaluator();
		this.currentFingerprint = this.createFingerprint();
	}

	private createEvaluator(): VisibilityEvaluator {
		const sortedRuleSets = [...this.ruleSets].sort((left, right) =>
			left.priority - right.priority
			|| pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)
			|| (left.sourcePath ?? "").localeCompare(right.sourcePath ?? ""));
		return new VisibilityEvaluator(
			this.options.root,
			sortedRuleSets,
			this.options.tracked.paths,
			this.options.policy,
			this.options.caseInsensitive,
		);
	}

	private createFingerprint(): string {
		return buildVisibilityFingerprint(
			this.options.policy,
			this.options.caseInsensitive,
			this.ruleFiles,
			this.options.tracked.paths,
		);
	}
}

function workspaceDirectory(directory: DirectoryRef): string | undefined {
	if (directory.workspacePath === undefined) return undefined;
	return directory.workspacePath.replaceAll("\\", "/").replace(/\/+$/u, "") || ".";
}

function ruleCandidates(
	policy: VisibilityPolicy,
	entries: readonly VisibilityDirectoryEntry[],
): Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> {
	const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.name));
	const result: Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> = [];
	if (policy.ignore.gitignore.enabled && files.has(".gitignore")) {
		result.push({ name: ".gitignore", sourceType: "gitignore" });
	}
	if (policy.ignore.piignore.enabled && files.has(".piignore")) {
		result.push({ name: ".piignore", sourceType: "piignore" });
	}
	return result;
}

function aborted(pathname: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Operation aborted.", path: pathname });
}
