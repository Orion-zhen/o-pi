import type { PermissionPromptContext, PermissionRequest, PolicyEvaluation, UserPermissionDecision } from "./permission-types.js";

interface QueueItem {
	request: PermissionRequest;
	evaluation: PolicyEvaluation;
	context: PermissionPromptContext;
	resolve(decision: UserPermissionDecision): void;
}

/** 串行化权限弹窗；相同 fingerprint 的并发请求共享结果。 */
export class ApprovalCoordinator {
	private queue: QueueItem[] = [];
	private running = false;
	private readonly pendingByFingerprint = new Map<string, Promise<UserPermissionDecision>>();
	private cancelledReason: string | undefined;

	request(
		request: PermissionRequest,
		evaluation: PolicyEvaluation,
		context: PermissionPromptContext,
	): Promise<UserPermissionDecision> {
		if (this.cancelledReason !== undefined) return Promise.resolve({ decision: "deny" });
		const existing = this.pendingByFingerprint.get(request.normalizedInputFingerprint);
		if (existing !== undefined) return existing;
		const promise = new Promise<UserPermissionDecision>((resolve) => {
			this.queue.push({ request, evaluation, context, resolve });
			this.drain();
		});
		this.pendingByFingerprint.set(request.normalizedInputFingerprint, promise);
		promise.finally(() => this.pendingByFingerprint.delete(request.normalizedInputFingerprint)).catch(() => undefined);
		return promise;
	}

	cancelAll(reason: string): void {
		this.cancelledReason = reason;
		const queued = this.queue.splice(0);
		for (const item of queued) item.resolve({ decision: "deny" });
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (;;) {
				const item = this.queue.shift();
				if (item === undefined) return;
				if (this.cancelledReason !== undefined) {
					item.resolve({ decision: "deny" });
					continue;
				}
				try {
					item.resolve(await item.context.prompt(item.request, item.evaluation));
				} catch {
					item.resolve({ decision: "deny" });
				}
			}
		} finally {
			this.running = false;
		}
	}
}
