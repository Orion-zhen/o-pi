import type { FsOperationContext } from "../../contracts/result.js";
import type { VisibilityPolicy } from "../../contracts/visibility.js";
import type { WorkspaceNamespaceKernel } from "../../kernel/namespace.js";
import { NodeNativeFileSystem, type NativeFileSystem } from "../../platform/node/native-filesystem.js";
import { GitTrackedFilesLoader } from "./git-tracked-files.js";
import {
	compileBaseVisibilityRules,
	resolveCaseInsensitive,
} from "./rule-compiler.js";
import { IncrementalVisibilityOperations } from "./incremental-operations.js";

/** Owns incremental runtime evaluators and shared Git state. */
export class WorkspaceVisibilityService {
	private readonly native: NativeFileSystem;
	private readonly git: GitTrackedFilesLoader;

	constructor(native: NativeFileSystem = new NodeNativeFileSystem()) {
		this.native = native;
		this.git = new GitTrackedFilesLoader(native);
	}

	async createOperations(
		root: string,
		policy: VisibilityPolicy,
		namespace: WorkspaceNamespaceKernel,
		context: FsOperationContext,
	): Promise<IncrementalVisibilityOperations> {
		const tracked = await this.git.load(root, context.signal);
		const caseInsensitive = resolveCaseInsensitive(tracked.ignoreCase);
		return new IncrementalVisibilityOperations({
			root,
			policy,
			native: this.native,
			namespace,
			tracked,
			caseInsensitive,
			base: compileBaseVisibilityRules(policy.ignore, caseInsensitive),
			context,
		});
	}

	dispose(): void {
		this.git.clear();
	}
}
