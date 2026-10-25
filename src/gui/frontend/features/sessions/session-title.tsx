import { useLayoutEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { GuiSessionActivity } from "../../../shared/protocol/state.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characters = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);

export function SessionTitle({ title, state }: { title: string; state: GuiSessionActivity["titleGeneration"] }) {
	const previous = useRef({ title, state });
	const display = useMotionValue(title);
	const reducedMotion = useReducedMotion();
	useLayoutEffect(() => {
		const before = previous.current;
		previous.current = { title, state };
		if (reducedMotion || before.state !== "generating" || state !== "complete" || before.title === title) {
			display.set(title);
			return;
		}
		const oldText = characters(before.title);
		const newText = characters(title);
		const erase = Math.min(0.25, oldText.length * 0.02);
		const duration = erase + 0.06 + Math.min(0.5, newText.length * 0.04);
		const animation = animate(-oldText.length, [-oldText.length, 0, 0, newText.length], {
			duration, times: [0, erase / duration, (erase + 0.06) / duration, 1], ease: "linear",
			onUpdate: (count) => display.set(count < 0
				? oldText.slice(0, Math.ceil(-count)).join("")
				: newText.slice(0, Math.floor(count)).join("")),
		});
		return () => animation.stop();
	}, [title, state, reducedMotion, display]);
	const generating = state === "generating";
	return <span className={`session-title-text${generating ? " motion-safe:animate-pulse" : ""}`}
		aria-busy={generating} title={generating ? "正在生成标题…" : undefined}>
		<span className="session-title-target">{title}</span>
		<motion.span className="session-title-display" aria-hidden="true">{display}</motion.span>
	</span>;
}
