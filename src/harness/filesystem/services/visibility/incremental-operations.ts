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
import { rethrowVisibilityAbort, type VisibilityRuleFile } from "./model.js";
import { compileVisibilityRuleFiles, type CompiledVisibilityRules } from "./rule-compiler.js";

interface IncrementalVisibilityOptions {
	readonly policy: VisibilityPolicy;
	readonly native: NativeFileSystem;
	readonly namespace: WorkspaceNamespaceKernel;
	readonly tracked: GitTrackedFiles;
	readonly caseInsensitive: boolean;
	readonly base: CompiledVisibilityRules;
	readonly context: FsOperationContext;
}

/** 按目录增量加载规则，不变的配置匹配器和 tracked 集合只构造一次。 */
export class IncrementalVisibilityOperations implements VisibilityOperations {
	private readonly prepared = new Map<string, Promise<FsResult<void>>>();
	private readonly evaluator: VisibilityEvaluator;

	constructor(private readonly options: IncrementalVisibilityOptions) {
		this.evaluator = new VisibilityEvaluator(options.base.ruleSets, options.tracked.paths, options.policy, options.caseInsensitive);
	}

	async evaluate(ref: ExistingRef, intent: VisibilityIntent): Promise<FsResult<VisibilityAnnotation>> {
		if (this.options.context.signal?.aborted === true) return aborted(ref.displayPath);
		const identity = nativeIdentity(this.options.namespace.bridge, ref);
		if (!identity.ok) return identity;
		const prepared = await this.prepareParentRules(ref);
		if (!prepared.ok) return prepared;
		const decision = this.evaluator.evaluate({
			displayPath: ref.displayPath,
			absolutePath: identity.value.lexicalPath,
			...(ref.workspacePath === undefined ? {} : { workspacePath: ref.workspacePath }),
			kind: ref.kind,
			intent,
		});
		const rule = decision.matchedRule;
		return fsSuccess({
			ignored: decision.ignored,
			prune: decision.prune,
			...(rule === undefined ? {} : { source: rule.sourcePath ?? rule.sourceType, rule: rule.pattern }),
		});
	}

	async prepareDirectory(directory: DirectoryRef, entries: readonly VisibilityDirectoryEntry[]): Promise<FsResult<void>> {
		if (this.options.context.signal?.aborted === true) return aborted(directory.displayPath);
		const parents = await this.prepareParentRules(directory);
		return parents.ok ? this.ensureDirectoryPrepared(directory, entries) : parents;
	}

	private async prepareParentRules(ref: ExistingRef): Promise<FsResult<void>> {
		const workspacePath = ref.workspacePath;
		if (workspacePath === undefined || workspacePath === ".") return fsSuccess(undefined);
		const parent = path.posix.dirname(workspacePath.replaceAll("\\", "/"));
		const pending = this.prepared.get(parent);
		if (pending !== undefined) return pending;

		let current = this.options.namespace.root;
		if (parent !== ".") {
			for (const segment of parent.split("/")) {
				const prepared = await this.ensureDirectoryPrepared(current);
				if (!prepared.ok) return prepared;
				const resolved = await this.options.namespace.bridge.resolveChild(current, segment);
				if (!resolved.ok) return resolved.error.code === "aborted" ? resolved : fsSuccess(undefined);
				if (resolved.value.ref.kind !== "directory") return fsSuccess(undefined);
				current = resolved.value.ref;
			}
		}
		return this.ensureDirectoryPrepared(current);
	}

	private async ensureDirectoryPrepared(directory: DirectoryRef, entries?: readonly VisibilityDirectoryEntry[]): Promise<FsResult<void>> {
		const key = directory.workspacePath;
		if (key === undefined) return fsSuccess(undefined);
		const identity = nativeIdentity(this.options.namespace.bridge, directory);
		if (!identity.ok) return identity;
		const cached = this.prepared.get(key);
		if (cached !== undefined) return cached;
		// 在等待 I/O 前登记整个加载任务，并在同一处处理失败和失效。
		const pending = this.loadDirectoryRules(identity.value.nativePath, key, entries).then(
			() => fsSuccess(undefined),
			(error: unknown) => {
				this.prepared.delete(key);
				return fsFailure(mapNativeError(error, directory.displayPath));
			},
		);
		this.prepared.set(key, pending);
		return pending;
	}

	private async loadDirectoryRules(nativeDirectory: string, baseDirectory: string, entries?: readonly VisibilityDirectoryEntry[]): Promise<void> {
		const context = this.options.context;
		if (entries === undefined) {
			try {
				entries = await this.options.native.readdir(nativeDirectory, context);
			} catch (error) {
				rethrowVisibilityAbort(error);
				return;
			}
		}
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
				});
			} catch (error) {
				rethrowVisibilityAbort(error);
			}
		}
		if (files.length === 0) return;
		const compiled = await compileVisibilityRuleFiles(this.options.native, files, this.options.caseInsensitive, context);
		this.evaluator.addRules(compiled.ruleSets);
	}
}

function ruleCandidates(
	policy: VisibilityPolicy,
	entries: readonly VisibilityDirectoryEntry[],
): Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> {
	const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.name));
	const result: Array<{ readonly name: string; readonly sourceType: "gitignore" | "piignore" }> = [];
	if (policy.ignore.gitignore.enabled && files.has(".gitignore")) result.push({ name: ".gitignore", sourceType: "gitignore" });
	if (policy.ignore.piignore.enabled && files.has(".piignore")) result.push({ name: ".piignore", sourceType: "piignore" });
	return result;
}

function aborted(pathname: string): FsResult<never> {
	return fsFailure({ code: "aborted", message: "Operation aborted.", path: pathname });
}
