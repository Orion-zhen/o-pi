import { assert } from "vitest";
import type { SessionApprovalStore } from "../../../src/harness/approval/rules/store.ts";
import type { ApprovalRequest, ApprovalUnit } from "../../../src/harness/approval/types.ts";

export function remember(store: SessionApprovalStore, request: ApprovalRequest, units: readonly ApprovalUnit[] = request.units): void {
	const commit = store.prepareRemember(request, units);
	assert.isDefined(commit);
	commit();
}
