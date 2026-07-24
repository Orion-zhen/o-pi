import type { Worker } from "node:worker_threads";

export class WorkerTaskAbortedError extends Error {
	constructor() {
		super("worker task aborted");
		this.name = "WorkerTaskAbortedError";
	}
}

export interface WorkerTaskPoolOptions<TRequest, TResult> {
	workerLimit: number;
	createWorker: () => Worker;
	decodeResponse: (message: unknown) => { id: number; result?: TResult; error?: string } | undefined;
	workerName: string;
	requestForTask: (id: number, request: TRequest) => unknown;
}

interface WorkerTask<TRequest, TResult> {
	id: number;
	request: TRequest;
	resolve(result: TResult): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
	settled: boolean;
}

interface WorkerSlot<TRequest, TResult> {
	worker: Worker;
	task?: WorkerTask<TRequest, TResult>;
	stopping: boolean;
}

/** 有界 worker 任务生命周期：队列、request ID、abort、崩溃、ref/unref 和 dispose。 */
export class WorkerTaskPool<TRequest, TResult> {
	private readonly queue: WorkerTask<TRequest, TResult>[] = [];
	private readonly slots = new Set<WorkerSlot<TRequest, TResult>>();
	private nextTaskId = 1;
	private disposed = false;

	constructor(private readonly options: WorkerTaskPoolOptions<TRequest, TResult>) {
		if (!Number.isInteger(options.workerLimit) || options.workerLimit < 1) throw new Error("workerLimit must be positive");
	}

	get workerCount(): number {
		return this.slots.size;
	}

	run(request: TRequest, signal?: AbortSignal): Promise<TResult> {
		if (this.disposed) return Promise.reject(new Error(`${this.options.workerName} pool is disposed`));
		return new Promise((resolve, reject) => {
			const task: WorkerTask<TRequest, TResult> = {
				id: this.nextTaskId,
				request,
				resolve,
				reject,
				...(signal !== undefined ? { signal } : {}),
				settled: false,
			};
			this.nextTaskId += 1;
			if (signal?.aborted) {
				task.settled = true;
				reject(new WorkerTaskAbortedError());
				return;
			}
			if (signal !== undefined) {
				task.onAbort = () => this.abortTask(task);
				signal.addEventListener("abort", task.onAbort, { once: true });
			}
			this.queue.push(task);
			this.dispatch();
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const task of this.queue.splice(0)) this.rejectTask(task, new WorkerTaskAbortedError());
		for (const slot of this.slots) {
			if (slot.task !== undefined) this.rejectTask(slot.task, new WorkerTaskAbortedError());
			slot.stopping = true;
			void slot.worker.terminate();
		}
		this.slots.clear();
	}

	private dispatch(): void {
		if (this.disposed) return;
		let idleWorkers = Array.from(this.slots).filter((slot) => slot.task === undefined && !slot.stopping).length;
		while (this.slots.size < this.options.workerLimit && idleWorkers < this.queue.length) {
			try {
				this.spawnWorker();
				idleWorkers += 1;
			} catch (error) {
				const task = this.nextQueuedTask();
				if (task !== undefined) this.rejectTask(task, error instanceof Error ? error : new Error(String(error)));
			}
		}
		for (const slot of this.slots) {
			if (slot.task !== undefined || slot.stopping) continue;
			const task = this.nextQueuedTask();
			if (task === undefined) return;
			slot.task = task;
			slot.worker.ref();
			try {
				slot.worker.postMessage(this.options.requestForTask(task.id, task.request));
			} catch (error) {
				this.failWorker(slot, error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private spawnWorker(): void {
		const worker = this.options.createWorker();
		const slot: WorkerSlot<TRequest, TResult> = { worker, stopping: false };
		this.slots.add(slot);
		worker.on("message", (message: unknown) => this.finishTask(slot, message));
		worker.on("error", (error: Error) => this.failWorker(slot, error));
		worker.on("exit", (code: number) => {
			if (!slot.stopping) this.failWorker(slot, new Error(`${this.options.workerName} worker exited with code ${code}`));
		});
		worker.unref();
	}

	private nextQueuedTask(): WorkerTask<TRequest, TResult> | undefined {
		while (this.queue.length > 0) {
			const task = this.queue.shift();
			if (task !== undefined && !task.settled) return task;
		}
		return undefined;
	}

	private finishTask(slot: WorkerSlot<TRequest, TResult>, message: unknown): void {
		const task = slot.task;
		const response = this.options.decodeResponse(message);
		if (task === undefined || response === undefined || response.id !== task.id) {
			this.failWorker(slot, new Error(`${this.options.workerName} worker returned an unexpected task`));
			return;
		}
		delete slot.task;
		slot.worker.unref();
		if (response.result !== undefined) this.resolveTask(task, response.result);
		else this.rejectTask(task, new Error(response.error ?? `${this.options.workerName} worker failed`));
		this.dispatch();
	}

	private failWorker(slot: WorkerSlot<TRequest, TResult>, error: Error): void {
		if (!this.slots.delete(slot)) return;
		slot.stopping = true;
		void slot.worker.terminate();
		if (slot.task !== undefined) this.rejectTask(slot.task, error);
		this.dispatch();
	}

	private abortTask(task: WorkerTask<TRequest, TResult>): void {
		if (task.settled) return;
		const queuedIndex = this.queue.indexOf(task);
		if (queuedIndex >= 0) {
			this.queue.splice(queuedIndex, 1);
			this.rejectTask(task, new WorkerTaskAbortedError());
			return;
		}
		const slot = Array.from(this.slots).find((candidate) => candidate.task === task);
		if (slot === undefined) return;
		this.slots.delete(slot);
		slot.stopping = true;
		delete slot.task;
		this.rejectTask(task, new WorkerTaskAbortedError());
		void slot.worker.terminate();
		this.dispatch();
	}

	private resolveTask(task: WorkerTask<TRequest, TResult>, result: TResult): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.resolve(result);
	}

	private rejectTask(task: WorkerTask<TRequest, TResult>, error: Error): void {
		if (task.settled) return;
		task.settled = true;
		this.removeAbortListener(task);
		task.reject(error);
	}

	private removeAbortListener(task: WorkerTask<TRequest, TResult>): void {
		if (task.signal !== undefined && task.onAbort !== undefined) task.signal.removeEventListener("abort", task.onAbort);
		delete task.onAbort;
	}
}
