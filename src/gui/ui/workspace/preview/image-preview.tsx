import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import { IconButton } from "../../components/icon-button";
import { Button } from "../../components/ui/button";
import { fileSize, usePreviewViewport } from "./preview-viewport.ts";
import { stepZoom, ZoomInput } from "./zoom-input.tsx";

type Point = { x: number; y: number };
const origin: Point = { x: 0, y: 0 };

export default function ImagePreview({ url, path, size }: { url: string; path: string; size: number }) {
	const viewport = usePreviewViewport();
	const [dimensions, setDimensions] = useState<Point>();
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [zoom, setZoom] = useState<number | "fit">("fit");
	const [pan, setPan] = useState(origin);
	const pointers = useRef(new Map<number, Point>());
	const scale = zoom === "fit" ? dimensions ? Math.min(1, Math.max(1, viewport.width - 24) / dimensions.x, Math.max(1, viewport.height - 24) / dimensions.y) : 1 : zoom;
	const clamp = (point: Point, nextScale: number): Point => {
		const x = Math.max(0, ((dimensions?.x ?? 0) * nextScale - viewport.width) / 2);
		const y = Math.max(0, ((dimensions?.y ?? 0) * nextScale - viewport.height) / 2);
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
		const previous = pointers.current.get(event.pointerId);
		if (!previous) return;
		const before = [...pointers.current.values()];
		const next = { x: event.clientX, y: event.clientY };
		pointers.current.set(event.pointerId, next);
		const after = [...pointers.current.values()];
		if (before.length === 2 && after.length === 2) {
			const [a, b] = before;
			const [c, d] = after;
			if (!a || !b || !c || !d) return;
			const distance = Math.hypot(a.x - b.x, a.y - b.y);
			if (!distance) return;
			const rect = event.currentTarget.getBoundingClientRect();
			zoomAt(scale * Math.hypot(c.x - d.x, c.y - d.y) / distance, { x: (c.x + d.x) / 2 - rect.x - rect.width / 2, y: (c.y + d.y) / 2 - rect.y - rect.height / 2 });
		} else setPan(clamp({ x: shownPan.x + next.x - previous.x, y: shownPan.y + next.y - previous.y }, scale));
	};
	return <div className="image-reader media-reader">
		<div className="media-toolbar" aria-label="图片工具栏">
			<IconButton label="缩小图片" size="icon-sm" disabled={!dimensions || scale <= 0.01} onClick={() => zoomAt(stepZoom(scale, -1))}><Minus /></IconButton>
			<ZoomInput label="图片缩放比例" scale={scale} min={0.01} max={32} disabled={!dimensions || error} onChange={zoomAt} />
			<IconButton label="放大图片" size="icon-sm" disabled={!dimensions || scale >= 32} onClick={() => zoomAt(stepZoom(scale, 1))}><Plus /></IconButton>
			<IconButton label="适应窗口" size="icon-sm" aria-pressed={zoom === "fit"} onClick={() => { setZoom("fit"); setPan(origin); }}><Scan /></IconButton>
			<IconButton label="实际大小" size="icon-sm" aria-pressed={zoom === 1} onClick={() => zoomAt(1)}><span className="text-xs">1:1</span></IconButton>
			<span className="media-details">{dimensions && `${dimensions.x} × ${dimensions.y} · `}{fileSize(size)}</span>
		</div>
		<div className="image-viewport" ref={viewport.ref} tabIndex={0} aria-label="图片正文"
			onKeyDown={(event) => {
				if (event.key === "+" || event.key === "=") zoomAt(stepZoom(scale, 1));
				else if (event.key === "-") zoomAt(stepZoom(scale, -1));
				else if (event.key.startsWith("Arrow")) setPan(clamp({ x: shownPan.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: shownPan.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) }, scale));
				else return;
				event.preventDefault();
			}}
			onPointerDown={(event) => { if (event.button !== 0 || !dimensions || error) return; pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId); }}
			onPointerMove={move} onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
			onPointerUp={(event) => pointers.current.delete(event.pointerId)} onPointerCancel={(event) => pointers.current.delete(event.pointerId)}>
			{error ? <div className="file-hint"><p role="alert">图片无法解码或读取失败。</p>
				<Button variant="outline" size="sm" onClick={() => { setError(false); setDimensions(undefined); setAttempt(attempt + 1); }}>重试图片</Button></div> : <>
				{!dimensions && <p className="file-hint" role="status">正在加载图片…</p>}
				<img key={attempt} src={url} alt={path} decoding="async" draggable={false} className="file-preview-image"
					onLoad={(event) => setDimensions({ x: event.currentTarget.naturalWidth, y: event.currentTarget.naturalHeight })} onError={() => setError(true)}
					style={{ visibility: dimensions ? "visible" : "hidden", width: dimensions ? dimensions.x * scale : undefined, height: dimensions ? dimensions.y * scale : undefined, transform: `translate(calc(-50% + ${shownPan.x}px), calc(-50% + ${shownPan.y}px))` }} />
			</>}
		</div>
	</div>;
}
