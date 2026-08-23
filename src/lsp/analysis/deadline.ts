export interface OperationDeadline {
	signal: AbortSignal;
	requestOptions(): { signal: AbortSignal; timeoutMs: number };
	dispose(): void;
}

export function createOperationDeadline(parent: AbortSignal | undefined, timeoutMs: number): OperationDeadline {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (parent?.aborted === true) controller.abort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const deadline = Date.now() + timeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	return {
		signal: controller.signal,
		requestOptions: () => ({ signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) }),
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

export function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
