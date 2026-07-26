import type { ExistingRef } from "../contracts/path.js";
import { fsFailure, fsSuccess, type FsResult } from "../contracts/result.js";
import type { NativePathIdentity, WorkspaceNamespaceBridge } from "../kernel/namespace.js";

export function nativeIdentity(
	bridge: WorkspaceNamespaceBridge,
	ref: ExistingRef,
): FsResult<NativePathIdentity> {
	const identity = bridge.getNativeIdentity(ref);
	if (identity !== undefined) return fsSuccess(identity);
	return fsFailure({ code: "invalid-path", message: "Path reference does not belong to this filesystem.", path: ref.displayPath });
}
