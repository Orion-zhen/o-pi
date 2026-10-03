import type { Transition } from "motion/react";

export const settle = { type: "spring", duration: 0.28, bounce: 0 } satisfies Transition;
export const fade = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] },
} as const;
