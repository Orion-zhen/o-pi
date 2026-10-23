import { useState, type ReactNode } from "react";
import { AnimatePresence, type Variants } from "motion/react";
import { Fade } from "./animated.tsx";

const variants: Variants = {
	enter: (direction: number) => ({ opacity: 0, x: direction * 8 }),
	center: { opacity: 1, x: 0 },
	exit: (direction: number) => ({ opacity: 0, x: direction * -8, transition: { duration: 0.12 } }),
};

export function TransitionPanel({ activeIndex, children }: { activeIndex: number; children: ReactNode }) {
	const [selection, setSelection] = useState({ index: activeIndex, direction: 0 });
	if (selection.index !== activeIndex) setSelection({ index: activeIndex, direction: Math.sign(activeIndex - selection.index) });
	return <div className="transition-panel">
		<AnimatePresence initial={false} mode="popLayout" custom={selection.direction}>
			<Fade key={activeIndex} custom={selection.direction} variants={variants} initial="enter" animate="center" exit="exit">{children}</Fade>
		</AnimatePresence>
	</div>;
}
