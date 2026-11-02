import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export class DisclosureMemory {
	private values: Map<string, boolean | null>;
	private listeners = new Set<() => void>();
	constructor(entries?: Iterable<readonly [string, boolean | null]>) { this.values = new Map(entries); }
	get(key: string) { return this.values.get(key); }
	subscribe(key: string, initial: boolean | null, listener: () => void) {
		if (!this.values.has(key)) this.values.set(key, initial);
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	set(key: string, value: boolean | null) {
		if (this.values.get(key) === value) return;
		this.values.set(key, value);
		for (const listener of this.listeners) listener();
	}
}
export const DisclosureMemoryContext = createContext<DisclosureMemory | undefined>(undefined);

export function useDisclosureMemory(key: string, initial: boolean): readonly [boolean, (next: boolean) => void];
export function useDisclosureMemory(key: string, initial: null): readonly [boolean | null, (next: boolean) => void];
export function useDisclosureMemory(key: string, initial: boolean | null) {
	const memory = useContext(DisclosureMemoryContext);
	if (!memory) throw new Error("折叠状态缺少会话上下文。");
	const subscribe = useCallback((listener: () => void) => memory.subscribe(key, initial, listener), [memory, key, initial]);
	const read = useCallback(() => {
		const saved = memory.get(key);
		return saved === undefined ? initial : saved;
	}, [memory, key, initial]);
	const value = useSyncExternalStore(subscribe, read, read);
	const change = useCallback((next: boolean) => memory.set(key, next), [memory, key]);
	return [value, change] as const;
}
