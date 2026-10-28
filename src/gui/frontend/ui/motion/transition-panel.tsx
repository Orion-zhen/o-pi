import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, type HTMLMotionProps, type Variants } from "motion/react";
import { Fade } from "./animated.tsx";
import { fade, controlShift } from "./transitions.ts";

type Movement = { axis: "x" | "y"; direction: number };
const variants: Variants = {
	enter: ({ axis, direction }: Movement) => ({ opacity: 0, x: axis === "x" ? direction * 8 : 0, y: axis === "y" ? direction * 4 : 0 }),
	center: { opacity: 1, x: 0, y: 0 },
	exit: ({ axis, direction }: Movement) => ({ opacity: 0, x: axis === "x" ? direction * -8 : 0, y: axis === "y" ? direction * -4 : 0, transition: axis === "x" ? { duration: 0.12 } : controlShift }),
};

function InlineFade(props: HTMLMotionProps<"span">) {
	const present = useIsPresent();
	return <motion.span {...fade} {...props} inert={!present} aria-hidden={!present} />;
}

export function TransitionPanel({ activeIndex, axis = "x", children }: { activeIndex: number; axis?: Movement["axis"]; children: ReactNode }) {
	const [selection, setSelection] = useState({ index: activeIndex, direction: 0 });
	if (selection.index !== activeIndex) setSelection({ index: activeIndex, direction: Math.sign(activeIndex - selection.index) });
	const movement = { axis, direction: selection.direction };
	const Container = axis === "y" ? "span" : "div";
	const Content = axis === "y" ? InlineFade : Fade;
	return <Container className="transition-panel" data-axis={axis}>
		<AnimatePresence initial={false} mode="popLayout" custom={movement}>
			<Content key={activeIndex} custom={movement} variants={variants} initial="enter" animate="center" exit="exit" transition={axis === "y" ? controlShift : fade.transition}>{children}</Content>
		</AnimatePresence>
	</Container>;
}
