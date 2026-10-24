import type { Transition } from "motion/react";

export const settle = { type: "spring", duration: 0.28, bounce: 0 } satisfies Transition;
export const feedback = { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] } as const;
export const listDepth = {
	hidden: { transform: "perspective(700px) translateZ(-32px)", filter: "blur(3px) opacity(0)" },
	visible: { transform: "perspective(700px) translateZ(0px)", filter: "blur(0px) opacity(1)" },
	transition: { duration: 0.32, ease: [0.2, 0.65, 0.3, 1] },
} as const;
export const listDeparture = { ...listDepth.hidden, transition: listDepth.transition };

export const fade = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { ...feedback, duration: 0.16 },
} as const;
