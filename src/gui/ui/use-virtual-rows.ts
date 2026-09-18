import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";

/** 小列表保留自然布局，大列表只挂载视口附近的行。 */
export function useVirtualRows<T extends HTMLElement>(count: number, getKey: (index: number) => string, estimateSize: number) {
	const root = useRef<T>(null);
	const [scrollMargin, setScrollMargin] = useState(0);
	const windowed = count > 100;
	const [focused, setFocused] = useState<{ key: string; index: number }>();
	let focusedIndex = -1;
	if (focused) {
		if (focused.index < count && getKey(focused.index) === focused.key) focusedIndex = focused.index;
		else for (let index = 0; index < count; index++) if (getKey(index) === focused.key) { focusedIndex = index; break; }
	}
	const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
		const indexes = defaultRangeExtractor(range);
		if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
		return indexes.sort((a, b) => a - b);
	}, [focusedIndex]);
	const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
		count, getItemKey: getKey, estimateSize: () => estimateSize,
		getScrollElement: () => root.current?.closest<HTMLElement>("[data-list-scroll]") ?? null,
		overscan: 8, scrollMargin, enabled: windowed, rangeExtractor,
	});
	useLayoutEffect(() => {
		const element = root.current;
		const scroll = element?.closest<HTMLElement>("[data-list-scroll]");
		if (!windowed || !element || !scroll) return;
		const measure = () => setScrollMargin(element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroll);
		if (element.parentElement) observer.observe(element.parentElement);
		if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
		return () => observer.disconnect();
	}, [windowed, count]);
	useLayoutEffect(() => {
		const element = root.current;
		if (!windowed || !element) return;
		const focus = (event: FocusEvent) => {
			if (!(event.target instanceof HTMLElement)) return;
			const row = event.target.closest<HTMLElement>("[data-index]");
			if (row) { const index = Number(row.dataset.index); setFocused({ key: getKey(index), index }); }
		};
		const blur = (event: FocusEvent) => {
			if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) setFocused(undefined);
		};
		element.addEventListener("focusin", focus);
		element.addEventListener("focusout", blur);
		return () => { element.removeEventListener("focusin", focus); element.removeEventListener("focusout", blur); };
	}, [windowed, getKey]);
	const rows = windowed ? virtualizer.getVirtualItems() : Array.from({ length: count }, (_, index) => ({ index, key: getKey(index), start: 0 }));
	const style: CSSProperties | undefined = windowed ? { height: virtualizer.getTotalSize(), position: "relative", display: "block" } : undefined;
	const rowStyle = (start: number): CSSProperties | undefined => windowed
		? { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start - scrollMargin}px)` } : undefined;
	return { root, rows, style, rowStyle, windowed, virtualizer };
}
