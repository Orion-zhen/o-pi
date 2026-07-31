export interface SubagentExecutionLease {
	signal: AbortSignal;
	dispose(): void;
}

/** 跟踪当前 session 的执行；shutdown 时统一取消，完成后立即释放引用。 */
export class SubagentExecutionRegistry {
	private readonly controllers = new Set<AbortController>();

	start(externalSignal?: AbortSignal): SubagentExecutionLease {
		const controller = new AbortController();
		this.controllers.add(controller);
		const signal = externalSignal === undefined
			? controller.signal
			: AbortSignal.any([externalSignal, controller.signal]);
		let disposed = false;
		return {
			signal,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.controllers.delete(controller);
			},
		};
	}

	abortAll(reason: unknown = new DOMException("Subagent session shut down.", "AbortError")): void {
		for (const controller of this.controllers) controller.abort(reason);
		this.controllers.clear();
	}

	get activeCount(): number {
		return this.controllers.size;
	}
}
