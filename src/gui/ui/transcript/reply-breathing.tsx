import { memo, useLayoutEffect } from "react";
import { animate, motion, transform, useMotionValue, useTransform, type MotionStyle } from "motion/react";
import { breathingSegments } from "./breathing-segments.ts";
import { useReplyAnimation } from "./use-reply-animation.ts";
import "./reply-breathing.css";

const segments = breathingSegments.map((paths) => transform([0, 1], paths));
const segmentCount = segments.length;
const duration = 12;
const holdFraction = 0.16;
const beatDuration = duration / segmentCount;
const rotationDuration = beatDuration * 4;
const breathingDuration = duration / 4;
export const replyTiming: MotionStyle & Record<`--reply-${string}-duration`, string> = {
	"--reply-beat-duration": `${beatDuration}s`,
	"--reply-rotation-duration": `${rotationDuration}s`,
	"--reply-breathing-duration": `${breathingDuration}s`,
};
const beats = segments.flatMap((_, index) => [
	{ value: index, time: index / segmentCount },
	{ value: index, time: (index + holdFraction) / segmentCount },
]).concat({ value: segmentCount, time: 1 });
const values = beats.map((beat) => beat.value);
const times = beats.map((beat) => beat.time);

// 进度限定在 [0, segmentCount]，最后一帧使用最后一段的终点。
function shapeAt(progress: number): string {
	const index = Math.min(Math.floor(progress), segmentCount - 1);
	const segment = segments[index] as (position: number) => string;
	return segment(progress - index);
}

export const ReplyBreathing = memo(function ReplyBreathing() {
	const { ref, playing } = useReplyAnimation<HTMLDivElement>(true);
	const progress = useMotionValue(0);
	const path = useTransform(progress, shapeAt);
	useLayoutEffect(() => {
		if (!playing) return;
		const animation = animate(progress, values, {
			duration, times, ease: [0.45, 0, 0.55, 1], repeat: Infinity, autoplay: false,
		});
		animation.time = (Number(document.timeline.currentTime) / 1000) % duration;
		animation.play();
		return () => animation.stop();
	}, [progress, playing]);

	return <motion.div ref={ref} className="reply-breathing" role="status" aria-label="正在处理"
		initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 0.85 }}
		transition={{ duration: 0.2 }}>
		<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
			<motion.path d={path} fill="currentColor" />
		</svg>
		<span className="reply-status-label" data-active="true" aria-hidden="true">正在处理</span>
	</motion.div>;
});
