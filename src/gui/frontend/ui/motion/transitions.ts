import type { Transition } from "motion/react";

// 单位为秒。档位只表示时长，动画用途由预设决定。
export const motionDuration = {
	1: 0.12,
	2: 0.18,
	3: 0.28,
	4: 0.4,
	5: 0.6,
	6: 0.8,
	7: 1.2,
} as const;
export const motionEase = [0.2, 0.8, 0.2, 1] as const;

export function applyMotionTokens() {
	const style = document.documentElement.style;
	for (const [level, duration] of Object.entries(motionDuration)) {
		style.setProperty(`--motion-duration-${level}`, `${duration}s`);
	}
	style.setProperty("--motion-ease", `cubic-bezier(${motionEase.join(", ")})`);
}

export const settle = { type: "spring", duration: motionDuration[3], bounce: 0 } satisfies Transition;
export const feedback = { duration: motionDuration[3], ease: motionEase } as const;
export const dismiss = { duration: motionDuration[1], ease: motionEase } as const;
export const controlShift = { duration: motionDuration[4], ease: motionEase } as const;
export const listDepth = {
	hidden: { transform: "perspective(700px) translateZ(-32px)", filter: "blur(3px) opacity(0)" },
	visible: { transform: "perspective(700px) translateZ(0px)", filter: "blur(0px) opacity(1)" },
	transition: { duration: motionDuration[3], ease: [0.2, 0.65, 0.3, 1] },
} as const;
export const listDeparture = { ...listDepth.hidden, transition: listDepth.transition };

export const fade = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { duration: motionDuration[2], ease: motionEase },
} as const;

// 高亮包含淡入、停留、淡出，总时长不吸附到档位。
const highlightEnter = motionDuration[2];
const highlightHold = 0.4;
const highlightDuration = highlightEnter + highlightHold + motionDuration[7];
export const highlight = {
	duration: highlightDuration, ease: motionEase,
	times: [0, highlightEnter / highlightDuration, (highlightEnter + highlightHold) / highlightDuration, 1],
};
