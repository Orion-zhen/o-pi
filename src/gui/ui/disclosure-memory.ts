import { createContext, useContext, useState } from "react";

export type DisclosureMemory = Map<string, boolean | null>;
export const DisclosureMemoryContext = createContext<DisclosureMemory | undefined>(undefined);

export function useDisclosureMemory(key: string, initial: boolean): readonly [boolean, (next: boolean) => void];
export function useDisclosureMemory(key: string, initial: null): readonly [boolean | null, (next: boolean) => void];
export function useDisclosureMemory(key: string, initial: boolean | null) {
	const memory = useContext(DisclosureMemoryContext);
	if (!memory) throw new Error("折叠状态缺少会话上下文。");
	const [value, setValue] = useState(() => {
		const saved = memory.get(key);
		if (saved !== undefined) return saved;
		memory.set(key, initial);
		return initial;
	});
	const change = (next: boolean) => {
		memory.set(key, next);
		setValue(next);
	};
	return [value, change] as const;
}
