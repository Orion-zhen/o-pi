import type { Transition } from "motion/react";

// 动效时序与曲线只在这一处定义，CSS 变量由 applyMotionTokens 写入。
const fast = 0.12;
const normal = 0.18;
const layout = 0.28;
const ease = [0.2, 0.8, 0.2, 1] as const;

export function applyMotionTokens() {
	const style = document.documentElement.style;
	style.setProperty("--motion-fast", `${fast}s`);
	style.setProperty("--motion-normal", `${normal}s`);
	style.setProperty("--motion-layout", `${layout}s`);
	style.setProperty("--motion-ease", `cubic-bezier(${ease.join(", ")})`);
}

export const settle = { type: "spring", duration: layout, bounce: 0 } satisfies Transition;
export const feedback = { duration: layout, ease } as const;
export const controlShift = { duration: 0.4, ease } as const;
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
