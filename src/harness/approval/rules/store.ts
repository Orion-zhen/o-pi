import type { ApprovalRequest, ApprovalUnit } from "../types.ts";

/** 每个逻辑会话独享一组精确授权，不写入磁盘。 */
export class SessionApprovalStore {
	private keys = new Set<string>();

	remember(request: ApprovalRequest, units: readonly ApprovalUnit[]): void {
		const keys: string[] = [];
		for (const unit of units) {
			const key = ruleKey(request, unit);
			if (key === undefined) return;
			keys.push(key);
		}
		for (const key of keys) this.keys.add(key);
	}

	matchesAllowRule(request: ApprovalRequest, unit: ApprovalUnit): boolean {
		const key = ruleKey(request, unit);
		return key !== undefined && this.keys.has(key);
	}
}

function ruleKey(request: ApprovalRequest, unit: ApprovalUnit): string | undefined {
	if (!unit.remember || (request.tool === "bash" && !request.allowSessionMemory)) return undefined;
	const { kind, value } = unit.target;
	return JSON.stringify([request.tool, kind, request.tool === "webfetch" ? request.detail.scope : kind === "command" ? request.cwd : null, value]);
}

export type ApprovalRuleMatcher = Pick<SessionApprovalStore, "matchesAllowRule">;
