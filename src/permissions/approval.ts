import type { AuthorizationRequest, CompiledDecision, PermissionPromptContext, UserPermissionDecision } from "./permission-types.js";

interface QueueItem {
	request: AuthorizationRequest;
	decision: CompiledDecision;
	context: PermissionPromptContext;
	resolve(result: ApprovalResult): void;
}

interface ApprovalBatch {
	key: string;
	items: QueueItem[];
}

export type ApprovalResult =
	| { ok: true; decision: UserPermissionDecision }
	| { ok: false; reason: "timeout" | "cancelled" | "ui-error" };

/** 串行化审批 UI；相同输入 fingerprint 的并发请求共享一次审批。 */
export class ApprovalCoordinator {
	private readonly queue: ApprovalBatch[] = [];
	private readonly pending = new Map<string, ApprovalBatch>();
	private running = false;
	private cancelled = false;

	request(request: AuthorizationRequest, decision: CompiledDecision, context: PermissionPromptContext): Promise<ApprovalResult> {
		if (this.cancelled || context.signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });
		const key = request.inputFingerprint;
		return new Promise<ApprovalResult>((resolve) => {
			const item = { request, decision, context, resolve };
			const existing = this.pending.get(key);
			if (existing !== undefined) {
				existing.items.push(item);
				return;
			}
			const batch = { key, items: [item] };
			this.pending.set(key, batch);
			this.queue.push(batch);
			this.drain();
		});
	}

	cancelAll(): void {
		this.cancelled = true;
		for (const batch of this.pending.values()) {
			for (const item of batch.items.splice(0)) item.resolve({ ok: false, reason: "cancelled" });
		}
		this.queue.splice(0);
		this.pending.clear();
	}

	reset(): void {
		this.cancelled = false;
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (;;) {
				const batch = this.queue.shift();
				if (batch === undefined) return;
				const active = this.activeItems(batch);
				if (active.length === 0) {
					this.pending.delete(batch.key);
					continue;
				}
				const result = await this.askWithTimeout(active[0] ?? unreachable());
				this.resolveBatch(batch, active, result);
			}
		} finally {
			this.running = false;
		}
	}

	private activeItems(batch: ApprovalBatch): QueueItem[] {
		const active: QueueItem[] = [];
		for (const item of batch.items) {
			if (this.cancelled || item.context.signal?.aborted) {
				item.resolve({ ok: false, reason: "cancelled" });
			} else {
				active.push(item);
			}
		}
		batch.items = active;
		return active;
	}

	private resolveBatch(batch: ApprovalBatch, active: QueueItem[], result: ApprovalResult): void {
		this.pending.delete(batch.key);
		if (!result.ok || result.decision.decision !== "allow-once") {
			for (const item of active) item.resolve(result);
			return;
		}
		active[0]?.resolve(result);
		const remaining = active.slice(1);
		if (remaining.length === 0) return;
		const next = { key: batch.key, items: remaining };
		this.pending.set(next.key, next);
		this.queue.push(next);
	}

	private async askWithTimeout(item: QueueItem): Promise<ApprovalResult> {
		let timeout: NodeJS.Timeout | undefined;
		try {
			const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
				timeout = setTimeout(() => resolve({ ok: false, reason: "timeout" }), item.context.timeoutMs);
			});
			const promptPromise = item.context.prompt(item.request, item.decision).then((decision): ApprovalResult => ({ ok: true, decision }));
			return await Promise.race([timeoutPromise, promptPromise]);
		} catch {
			return { ok: false, reason: "ui-error" };
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}
}

function unreachable(): never {
	throw new Error("unreachable");
}
