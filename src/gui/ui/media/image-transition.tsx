import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { animate, motion, useMotionValue, usePresence } from "motion/react";
import { feedback } from "../lib/motion";

const expanded = { x: 0, y: 0, scale: 1, clipPath: "inset(0px 0px 0px 0px round 0px)" };

export function ImageTransition({ source, image, ready, children }: {
	source: HTMLImageElement; image: RefObject<HTMLImageElement | null>; ready: boolean; children: ReactNode;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const started = useRef(false);
	const [moving, setMoving] = useState(true);
	const [present, safeToRemove] = usePresence();
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const scale = useMotionValue(1);
	const clipPath = useMotionValue(expanded.clipPath);
	const opacity = useMotionValue(0);

	useLayoutEffect(() => {
		if (!ready) {
			if (!present) safeToRemove?.();
			return;
		}
		const element = frame.current;
		const picture = image.current;
		if (!element || !picture) return;
		const sourceRect = source.getBoundingClientRect();
		let collapsed: typeof expanded | undefined;
		if (source.isConnected && sourceRect.width > 0 && sourceRect.height > 0) {
			const frameRect = element.getBoundingClientRect();
			const imageRect = picture.getBoundingClientRect();
			const currentScale = scale.get();
			// 反算外层变换前的画面，保留阅读器缩放、拖动及尚未结束的入场动画。
			const centerX = (imageRect.x + imageRect.width / 2 - frameRect.x) / currentScale;
			const centerY = (imageRect.y + imageRect.height / 2 - frameRect.y) / currentScale;
			const nextScale = Math.max(sourceRect.width / imageRect.width, sourceRect.height / imageRect.height) * currentScale;
			const halfWidth = sourceRect.width / nextScale / 2;
			const halfHeight = sourceRect.height / nextScale / 2;
			const radius = parseFloat(getComputedStyle(source).borderTopLeftRadius) / nextScale;
			collapsed = {
				x: sourceRect.x + sourceRect.width / 2 - (frameRect.x - x.get()) - centerX * nextScale,
				y: sourceRect.y + sourceRect.height / 2 - (frameRect.y - y.get()) - centerY * nextScale,
				scale: nextScale,
				clipPath: `inset(${centerY - halfHeight}px ${frameRect.width / currentScale - centerX - halfWidth}px ${frameRect.height / currentScale - centerY - halfHeight}px ${centerX - halfWidth}px round ${radius}px)`,
			};
		}
		if (present && !started.current) {
			started.current = true;
			const initial = collapsed ?? expanded;
			x.set(initial.x);
			y.set(initial.y);
			scale.set(initial.scale);
			clipPath.set(initial.clipPath);
			opacity.set(collapsed ? 1 : 0);
		}
		const target = present ? expanded : collapsed ?? { x: x.get(), y: y.get(), scale: scale.get(), clipPath: clipPath.get() };
		const animations = [
			animate(x, target.x, feedback),
			animate(y, target.y, feedback),
			animate(scale, target.scale, feedback),
			animate(clipPath, target.clipPath, feedback),
			animate(opacity, present || collapsed ? 1 : 0, feedback),
		];
		let cancelled = false;
		void Promise.all(animations).then(() => {
			if (cancelled) return;
			if (present) setMoving(false);
			else safeToRemove?.();
		});
		return () => { cancelled = true; for (const animation of animations) animation.stop(); };
	}, [source, image, ready, present, safeToRemove, x, y, scale, clipPath, opacity]);

	return <motion.div ref={frame} className="image-preview-motion" data-moving={moving || !present}
		style={{ x, y, scale, clipPath, opacity, transformOrigin: "0 0" }}>{children}</motion.div>;
}
