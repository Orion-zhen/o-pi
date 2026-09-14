interface SharedBuildOptions {
	readonly createConsumerAbort: () => unknown;
	readonly onSettled: () => void;
}

/** One owner task with independently cancellable consumers. */
export class SharedBuild<T> {
	private readonly controller = new AbortController();
	private readonly promise: Promise<T>;
	private consumers = 0;
	private settled = false;
	private abortTimer: ReturnType<typeof setImmediate> | undefined;

	constructor(build: (signal: AbortSignal) => Promise<T>, private readonly options: SharedBuildOptions) {
		this.promise = Promise.resolve().then(async () => await build(this.controller.signal));
		void this.promise.then(
			() => this.settle(),
			() => this.settle(),
		);
	}

	async consume(signal?: AbortSignal): Promise<T> {
		this.cancelScheduledAbort();
		this.consumers += 1;
		let onAbort: (() => void) | undefined;
		try {
			if (signal === undefined) return await this.promise;
			if (signal.aborted) throw this.options.createConsumerAbort();
			const canceled = new Promise<T>((_resolve, reject) => {
				onAbort = () => reject(this.options.createConsumerAbort());
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			return await Promise.race([this.promise, canceled]);
		} finally {
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
			this.consumers -= 1;
			if (this.consumers === 0 && !this.settled) {
				this.abortTimer = setImmediate(() => {
					this.abortTimer = undefined;
					if (this.consumers === 0 && !this.settled) this.controller.abort(new Error("Shared build has no consumers."));
				});
			}
		}
	}

	abort(reason: unknown = new Error("Shared build was invalidated.")): void {
		this.cancelScheduledAbort();
		if (!this.settled) this.controller.abort(reason);
	}

	private settle(): void {
		if (this.settled) return;
		this.settled = true;
		this.cancelScheduledAbort();
		this.options.onSettled();
	}

	private cancelScheduledAbort(): void {
		if (this.abortTimer === undefined) return;
		clearImmediate(this.abortTimer);
		this.abortTimer = undefined;
	}
}
