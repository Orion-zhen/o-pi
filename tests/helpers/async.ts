export interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

export type DeferredVoid = Deferred<void>;

export function deferred<T>(): Deferred<T> {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

export function deferredVoid(): DeferredVoid {
	return deferred<void>();
}
