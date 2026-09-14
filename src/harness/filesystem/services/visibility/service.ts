import type { FsOperationContext } from "../../contracts/result.ts";
import type { VisibilityPolicy } from "../../contracts/visibility.ts";
import type { WorkspaceNamespaceKernel } from "../../kernel/namespace.ts";
import type { NativeFileSystem } from "../../platform/node/native-filesystem.ts";
import { GitTrackedFilesLoader } from "./git-tracked-files.ts";
import {
	compileBaseVisibilityRules,
	resolveCaseInsensitive,
} from "./rule-compiler.ts";
import { IncrementalVisibilityOperations } from "./incremental-operations.ts";

/** Owns incremental runtime evaluators and shared Git state. */
export class WorkspaceVisibilityService {
	private readonly native: NativeFileSystem;
	private readonly git: GitTrackedFilesLoader;

	constructor(native: NativeFileSystem) {
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
