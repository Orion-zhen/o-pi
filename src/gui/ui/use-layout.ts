import { useEffect, useState, type CSSProperties } from "react";

export type LayoutDimension = "left" | "right" | "conversation" | "files";
type LayoutValues = Partial<Record<LayoutDimension, number>>;
const dimensions: LayoutDimension[] = ["left", "right", "conversation", "files"];
const storageKey = (dimension: LayoutDimension) => `opi.gui.layout.v1.${dimension}`;

/** 布局只属于当前客户端，窗口收缩不会回写并覆盖用户拖动的尺寸。 */
export function useLayout(reportError: (message: string) => void) {
	const [values, setValues] = useState<LayoutValues>({});
	useEffect(() => {
		const values: LayoutValues = {};
		try {
			for (const dimension of dimensions) {
				const saved = localStorage.getItem(storageKey(dimension));
				if (saved === null) continue;
				const value = Number(saved);
				if (!Number.isFinite(value) || value <= 0 || (dimension === "files" && value >= 100))
					throw new Error(`无效布局尺寸：${dimension}`);
				values[dimension] = value;
			}
			setValues(values);
		} catch (error) { reportError(`无法恢复本机布局：${String(error)}`); }
	}, [reportError]);
	const set = (dimension: LayoutDimension, value: number | undefined, persist: boolean) => {
		setValues((current) => ({ ...current, [dimension]: value }));
		if (!persist) return;
		try {
			if (value === undefined) localStorage.removeItem(storageKey(dimension));
			else localStorage.setItem(storageKey(dimension), String(value));
		} catch (error) { reportError(`无法保存本机布局：${String(error)}`); }
	};
	const style: CSSProperties & Record<`--${string}`, string | undefined> = {
		"--sidebar-width": values.left === undefined ? undefined : `${values.left}px`,
		"--info-width": values.right === undefined ? undefined : `${values.right}px`,
		"--conversation-width": values.conversation === undefined ? undefined : `${values.conversation}px`,
	};
	return { values, set, style };
}
