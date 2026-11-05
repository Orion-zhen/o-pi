import { animateView } from "motion";
import { flushSync } from "react-dom";
import { themeReveal } from "../motion/transitions.ts";

export function animateThemeChange(origin: HTMLElement, update: () => void): void {
	const rect = origin.getBoundingClientRect();
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
	const clipPath = Math.random() < 0.5
		? [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
		: ["inset(0 100% 0 0)", "inset(0 0% 0 0)"];
	animateView(() => flushSync(update), { ...themeReveal, interrupt: "immediate" }).new({ clipPath });
}
