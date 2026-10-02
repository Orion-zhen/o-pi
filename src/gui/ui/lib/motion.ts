import type { Transition, Variants } from "motion/react";

export const settle = { type: "spring", duration: 0.28, bounce: 0 } satisfies Transition;
export const fade = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] },
} as const;

export const welcomeIdle = {
	rest: { y: 0, scaleY: 1, rotate: 0, transition: settle },
	stretch: {
		y: [0, 1, -5, -5, 0],
		scaleY: [1, 0.96, 1.08, 1.08, 1],
		rotate: [0, 0, -4, -4, 0],
		transition: { duration: 3.2, times: [0, 0.16, 0.55, 0.68, 1], ease: "easeInOut" },
	},
} satisfies Variants;
