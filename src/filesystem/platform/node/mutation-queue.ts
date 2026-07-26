interface MutationWaiter {
	settled: boolean;
	resolve(release: () => void): void;
	reject(error: MutationQueueUnavailableError): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface MutationQueueEntry {
	readonly waiters: MutationWaiter[];
}

export class MutationQueueUnavailableError extends Error {
	constructor(readonly reason: "aborted" | "disposed", options?: ErrorOptions) {
		super(reason === "aborted" ? "Mutation queue wait was aborted." : "Mutation queue is shut down.", options);
		this.name = "MutationQueueUnavailableError";
	}
}

/** Process-local keyed queue: one active mutation per canonical target. */
export class MutationQueue {
	private readonly entries = new Map<string, MutationQueueEntry>();
	private disposed = false;

	async run<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		const queueKey = process.platform === "win32" ? key.toLocaleLowerCase() : key;
		const release = await this.acquire(queueKey, signal);
		try {
			if (signal?.aborted === true) throw new MutationQueueUnavailableError("aborted", { cause: signal.reason });
			return await operation();
		} finally {
			release();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.entries.values()) {
			for (const waiter of entry.waiters.splice(0)) this.rejectWaiter(waiter);
		}
	}

	private async acquire(key: string, signal: AbortSignal | undefined): Promise<() => void> {
		if (this.disposed) throw new MutationQueueUnavailableError("disposed");
		if (signal?.aborted === true) throw new MutationQueueUnavailableError("aborted", { cause: signal.reason });
		let entry = this.entries.get(key);
		if (entry === undefined) {
			entry = { waiters: [] };
			this.entries.set(key, entry);
			return this.releaseFor(key, entry);
		}
		return await new Promise<() => void>((resolve, reject) => {
			const waiter: MutationWaiter = { settled: false, resolve, reject, ...(signal === undefined ? {} : { signal }) };
			if (signal !== undefined) {
				waiter.onAbort = () => {
					waiter.settled = true;
					const index = entry.waiters.indexOf(waiter);
					if (index >= 0) entry.waiters.splice(index, 1);
					reject(new MutationQueueUnavailableError("aborted", { cause: signal.reason }));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			entry.waiters.push(waiter);
		});
	}

	private releaseFor(key: string, entry: MutationQueueEntry): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (entry.waiters.length > 0) {
				const waiter = entry.waiters.shift();
				if (waiter === undefined || waiter.settled) continue;
				waiter.settled = true;
				this.removeAbortListener(waiter);
				waiter.resolve(this.releaseFor(key, entry));
				return;
			}
			if (this.entries.get(key) === entry) this.entries.delete(key);
		};
	}

	private rejectWaiter(waiter: MutationWaiter): void {
		waiter.settled = true;
		this.removeAbortListener(waiter);
		waiter.reject(new MutationQueueUnavailableError("disposed", waiter.signal?.reason === undefined ? undefined : { cause: waiter.signal.reason }));
	}

	private removeAbortListener(waiter: MutationWaiter): void {
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
}
