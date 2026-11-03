import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import { motion } from "motion/react";
import { IconButton } from "../icon-button.tsx";
import { fade } from "../motion/transitions.ts";
import { fileSize, usePreviewViewport } from "./preview-viewport.ts";
import { stepZoom, ZoomInput } from "./zoom-input.tsx";
import "./media.css";

type Point = { x: number; y: number };
const origin: Point = { x: 0, y: 0 };

/** 图片和像素画布共用的缩放、拖动及工具栏，不负责加载或解码。 */
export function ImageViewport({ dimensions, size, toolbar, fadeToolbar, onBackgroundClick, children }: {
	dimensions: { width: number; height: number } | undefined;
	size: number | undefined;
	toolbar?: ReactNode;
	fadeToolbar?: boolean;
	onBackgroundClick?: () => void;
	children: (style: CSSProperties, ready: boolean) => ReactNode;
}) {
	const viewport = usePreviewViewport();
	const [zoom, setZoom] = useState<number | "fit">("fit");
	const [pan, setPan] = useState(origin);
	const pointers = useRef(new Map<number, Point>());
	const backgroundPress = useRef<Point | undefined>(undefined);
	const scale = zoom === "fit" ? dimensions ? Math.min(1, Math.max(1, viewport.width - 24) / dimensions.width, Math.max(1, viewport.height - 24) / dimensions.height) : 1 : zoom;
	const clamp = (point: Point, nextScale: number): Point => {
		const x = Math.max(0, ((dimensions?.width ?? 0) * nextScale - viewport.width) / 2);
		const y = Math.max(0, ((dimensions?.height ?? 0) * nextScale - viewport.height) / 2);
		return { x: Math.max(-x, Math.min(x, point.x)), y: Math.max(-y, Math.min(y, point.y)) };
	};
	const shownPan = clamp(pan, scale);
	const zoomAt = (next: number, point = origin) => {
		next = Math.max(Math.min(scale, 0.01), Math.min(Math.max(scale, 32), next));
		setZoom(next);
		setPan(clamp({ x: point.x - (point.x - shownPan.x) * next / scale, y: point.y - (point.y - shownPan.y) * next / scale }, next));
	};
	const handleWheel = useEffectEvent((event: WheelEvent, element: HTMLDivElement) => {
		if (event.deltaY === 0) return;
		event.preventDefault();
		const rect = element.getBoundingClientRect();
		zoomAt(stepZoom(scale, event.deltaY < 0 ? 1 : -1), { x: event.clientX - rect.x - rect.width / 2, y: event.clientY - rect.y - rect.height / 2 });
	});
	useEffect(() => {
		const element = viewport.ref.current;
		if (!element) return;
		const wheel = (event: WheelEvent) => handleWheel(event, element);
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [viewport.ref]);
	const move = (event: PointerEvent<HTMLDivElement>) => {
		if (backgroundPress.current && Math.hypot(event.clientX - backgroundPress.current.x, event.clientY - backgroundPress.current.y) > 4)
			backgroundPress.current = undefined;
		const previous = pointers.current.get(event.pointerId);
		if (!previous) return;
		const [first, second, third] = pointers.current.values();
		const next = { x: event.clientX, y: event.clientY };
		pointers.current.set(event.pointerId, next);
		if (first && second && !third) {
			const other = first === previous ? second : first;
			const distance = Math.hypot(previous.x - other.x, previous.y - other.y);
			if (!distance) return;
			const rect = event.currentTarget.getBoundingClientRect();
			zoomAt(scale * Math.hypot(next.x - other.x, next.y - other.y) / distance, { x: (next.x + other.x) / 2 - rect.x - rect.width / 2, y: (next.y + other.y) / 2 - rect.y - rect.height / 2 });
		} else setPan(clamp({ x: shownPan.x + next.x - previous.x, y: shownPan.y + next.y - previous.y }, scale));
	};
	const pictureStyle: CSSProperties = {
		visibility: dimensions ? "visible" : "hidden",
		width: dimensions ? dimensions.width * scale : undefined,
		height: dimensions ? dimensions.height * scale : undefined,
		transform: `translate(calc(-50% + ${shownPan.x}px), calc(-50% + ${shownPan.y}px))`,
	};
	return <div className="image-reader media-reader">
		<motion.div {...(fadeToolbar ? fade : {})} className="media-toolbar" aria-label="图片工具栏">
			{toolbar}
			<IconButton label="缩小图片" size="icon-sm" disabled={!dimensions || scale <= 0.01} onClick={() => zoomAt(stepZoom(scale, -1))}><Minus /></IconButton>
			<ZoomInput label="图片缩放比例" scale={scale} min={0.01} max={32} disabled={!dimensions} onChange={zoomAt} />
			<IconButton label="放大图片" size="icon-sm" disabled={!dimensions || scale >= 32} onClick={() => zoomAt(stepZoom(scale, 1))}><Plus /></IconButton>
			<IconButton label="适应窗口" size="icon-sm" aria-pressed={zoom === "fit"} onClick={() => { setZoom("fit"); setPan(origin); }}><Scan /></IconButton>
			<IconButton label="实际大小" size="icon-sm" aria-pressed={zoom === 1} onClick={() => zoomAt(1)}><span className="text-xs">1:1</span></IconButton>
			<span className="media-details">{dimensions && `${dimensions.width} × ${dimensions.height}`}{size !== undefined && `${dimensions ? " · " : ""}${fileSize(size)}`}</span>
		</motion.div>
		<div className="image-viewport" ref={viewport.ref} tabIndex={0} aria-label="图片正文"
			onKeyDown={(event) => {
				if (event.key === "+" || event.key === "=") zoomAt(stepZoom(scale, 1));
				else if (event.key === "-") zoomAt(stepZoom(scale, -1));
				else if (event.key.startsWith("Arrow")) setPan(clamp({ x: shownPan.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: shownPan.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }, scale));
				else return;
				event.preventDefault();
			}}
			onPointerDown={(event) => {
				backgroundPress.current = onBackgroundClick && event.button === 0 && event.isPrimary && event.target === event.currentTarget && pointers.current.size === 0
					? { x: event.clientX, y: event.clientY } : undefined;
				if (event.button !== 0 || !dimensions) return;
				pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={move} onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
			onPointerUp={(event) => pointers.current.delete(event.pointerId)}
			onPointerCancel={(event) => { pointers.current.delete(event.pointerId); backgroundPress.current = undefined; }}
			onClick={(event) => {
				const close = backgroundPress.current && event.target === event.currentTarget;
				backgroundPress.current = undefined;
				if (close) onBackgroundClick?.();
			}}>
			{children(pictureStyle, !!dimensions && viewport.width > 0 && viewport.height > 0)}
		</div>
	</div>;
}
