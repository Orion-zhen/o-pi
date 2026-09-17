import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ResizeBounds { value: number; min: number; max: number; scale?: number }

/** 指针取消时撤销本次拖动，只有完成拖动或显式重置才持久化。 */
export function ResizeHandle({ label, axis = "x", value, measure, change, className = "" }: {
	label: string; axis?: "x" | "y"; value: number | undefined; measure: () => ResizeBounds;
	change: (value: number | undefined, persist: boolean) => void; className?: string;
}) {
	const element = useRef<HTMLDivElement>(null);
	const measureRef = useRef(measure);
	measureRef.current = measure;
	const changeRef = useRef(change);
	changeRef.current = change;
	const drag = useRef<{ start: number; bounds: ResizeBounds; original: number | undefined; latest: number | undefined }>(null);
	const [bounds, setBounds] = useState<ResizeBounds>({ value: 0, min: 0, max: 0 });
	const [dragging, setDragging] = useState(false);
	useLayoutEffect(() => {
		const parent = element.current?.parentElement;
		if (!parent) return;
		const observer = new ResizeObserver(() => setBounds(measureRef.current()));
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => { setBounds(measureRef.current()); }, [value]);
	useEffect(() => () => {
		if (drag.current) {
			delete document.body.dataset.guiResizing;
			changeRef.current(drag.current.original, false);
		}
	}, []);
	const finish = (commit: boolean) => {
		const current = drag.current;
		if (!current) return;
		drag.current = null;
		setDragging(false);
		delete document.body.dataset.guiResizing;
		if (!commit) change(current.original, false);
		else if (current.latest !== undefined) change(current.latest, true);
	};
	const clamp = (value: number, bounds: ResizeBounds) => Math.max(bounds.min, Math.min(bounds.max, value));
	return <div ref={element} role="separator" aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"}
		aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(bounds.value)}
		title="拖动调整，双击恢复默认" tabIndex={0} className={`resize-handle ${className}`} data-axis={axis} data-dragging={dragging}
		onDoubleClick={() => { finish(false); change(undefined, true); }}
		onPointerDown={(event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.currentTarget.focus({ preventScroll: true });
			drag.current = { start: axis === "x" ? event.clientX : event.clientY, bounds: measure(), original: value, latest: undefined };
			event.currentTarget.setPointerCapture(event.pointerId);
			setDragging(true);
			document.body.dataset.guiResizing = axis;
		}}
		onPointerMove={(event) => {
			const current = drag.current;
			if (!current) return;
			const delta = (axis === "x" ? event.clientX : event.clientY) - current.start;
			if (delta === 0 && current.latest === undefined) return;
			current.latest = clamp(current.bounds.value + delta * (current.bounds.scale ?? 1), current.bounds);
			change(current.latest, false);
		}}
		onPointerUp={(event) => { finish(true); event.currentTarget.releasePointerCapture(event.pointerId); }}
		onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
		onKeyDown={(event) => {
			if (event.key === "Escape") { finish(false); return; }
			if (event.key === "Home" || event.key === "Enter") {
				event.preventDefault(); change(undefined, true); return;
			}
			const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
			const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
			if (event.key !== negative && event.key !== positive) return;
			event.preventDefault();
			const bounds = measure();
			change(clamp(bounds.value + (event.key === negative ? -10 : 10) * (bounds.scale ?? 1), bounds), true);
		}}
	/>;
}
