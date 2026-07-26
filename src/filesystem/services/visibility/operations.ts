import type { ExistingRef } from "../../contracts/path.js";
import { fsFailure, fsSuccess, type FsOperationContext, type FsResult } from "../../contracts/result.js";
import type {
	VisibilityAnnotation,
	VisibilityIntent,
	VisibilityOperations,
	VisibilitySnapshot,
} from "../../contracts/visibility.js";
import type { WorkspaceNamespaceBridge } from "../../kernel/namespace.js";
import { nativeIdentity } from "../ref.js";

/** Binds one immutable visibility snapshot to opaque filesystem refs. */
export class SnapshotVisibilityOperations implements VisibilityOperations {
	readonly snapshot;

	constructor(
		private readonly source: VisibilitySnapshot,
		private readonly bridge: WorkspaceNamespaceBridge,
	) {
		this.snapshot = {
			fingerprint: source.fingerprint,
			diagnostics: source.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	}

	async evaluate(
		ref: ExistingRef,
		intent: VisibilityIntent,
		context: FsOperationContext,
	): Promise<FsResult<VisibilityAnnotation>> {
		if (context.signal?.aborted === true) {
			return fsFailure({ code: "aborted", message: "Operation aborted.", path: ref.displayPath });
		}
		const identity = nativeIdentity(this.bridge, ref);
		if (!identity.ok) return identity;
		const decision = this.source.evaluate({
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
}
