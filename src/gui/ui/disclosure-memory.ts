import { createContext, useContext, useState, type SetStateAction } from "react";

export type DisclosureMemory = Map<string, boolean | null>;
export const DisclosureMemoryContext = createContext<DisclosureMemory | undefined>(undefined);

export function useDisclosureMemory(key: string, initial: boolean | null) {
	const memory = useContext(DisclosureMemoryContext);
	const [value, setValue] = useState(() => {
		if (memory?.has(key)) return memory.get(key) ?? null;
		memory?.set(key, initial);
		return initial;
	});
	const change = (next: SetStateAction<boolean | null>) => setValue((current) => {
		const updated = typeof next === "function" ? next(current) : next;
		memory?.set(key, updated);
		return updated;
	});
	return [value, change] as const;
}
