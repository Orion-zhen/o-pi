import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { animate, cubicBezier, useMotionValue, useTransform } from "motion/react";
import { feedback } from "@/ui/motion/transitions.ts";
import { startupLists, startupSidebarDuration } from "./startup-lists.ts";
import { welcomeComposerFadeDuration, welcomeContentDuration, welcomeContentStart, welcomeDuration } from "./welcome-timing.ts";
import "./startup-motion.css";

const sidebars = [
	{ name: "left", selector: ".sidebar" },
	{ name: "right", selector: ".session-sidebar .session-tabs" },
] as const;
const composerEase = cubicBezier(...feedback.ease);

function finishSidebar(target: HTMLElement) {
	target.removeAttribute("data-startup");
	target.style.removeProperty("--startup-duration");
}

/** 入场在 App 内只消费一次，欢迎页和输入框通过组件生命周期参与。 */
export function useStartupMotion(root: RefObject<HTMLElement | null>, sessionReady: boolean) {
	const time = useMotionValue(welcomeDuration);
	const opacity = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeComposerFadeDuration], [0, 1], { ease: composerEase });
	const y = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeContentDuration], [12, 0], { ease: composerEase });
	const state = useRef<{
		seen: Set<"left" | "right" | "welcome" | "composer">; active: Set<HTMLElement>; stopped: boolean; sidebarEndsAt: number;
		lists?: ReturnType<typeof startupLists>;
	}>({ seen: new Set(), active: new Set(), stopped: false, sidebarEndsAt: 0 });
	const finishWelcome = useCallback(() => { time.stop(); time.set(welcomeDuration); }, [time]);
	const finishComposer = useCallback(() => { opacity.jump(1); y.jump(0); }, [opacity, y]);
	const enterWelcome = useCallback(() => {
		const startup = state.current;
		if (startup.stopped || startup.seen.has("welcome")) return;
		startup.seen.add("welcome");
		time.set(0);
		animate(time, welcomeDuration, { duration: welcomeDuration, ease: "linear" });
		return finishWelcome;
	}, [time, finishWelcome]);
	const composerRef = useCallback((element: HTMLElement | null) => {
		const startup = state.current;
		if (!element || startup.stopped || startup.seen.has("composer")) return;
		startup.seen.add("composer");
		// 欢迎页播放中直接使用共享时间。其余首次挂载只播放短入场。
		if (time.get() >= welcomeDuration) {
			animate(opacity, [0, 1], { duration: 0.16, ease: feedback.ease });
			animate(y, [12, 0], { duration: 0.24, ease: feedback.ease });
		}
		return finishComposer;
	}, [time, opacity, y, finishComposer]);

	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		const startup = state.current;
		const stop = () => {
			if (startup.stopped) return;
			startup.stopped = true;
			finishWelcome();
			finishComposer();
			startup.lists?.stop();
			for (const target of startup.active) finishSidebar(target);
			startup.active.clear();
		};
		const finished = (event: AnimationEvent) => {
			if (event.animationName !== "startup-settle" || !(event.target instanceof HTMLElement)) return;
			const target = event.target.closest<HTMLElement>("[data-startup]");
			if (target && startup.active.delete(target)) finishSidebar(target);
		};
		element.addEventListener("animationend", finished);
		window.addEventListener("pointerdown", stop, true);
		window.addEventListener("keydown", stop, true);
		window.addEventListener("wheel", stop, { capture: true, passive: true });
		window.addEventListener("resize", stop);
		return () => {
			stop();
			element.removeEventListener("animationend", finished);
			window.removeEventListener("pointerdown", stop, true);
			window.removeEventListener("keydown", stop, true);
			window.removeEventListener("wheel", stop, true);
			window.removeEventListener("resize", stop);
		};
	}, [root, finishWelcome, finishComposer]);

	useLayoutEffect(() => {
		const element = root.current;
		const startup = state.current;
		if (!element || startup.stopped) return;
		// 子组件已完成本次挂载，历史会话不能把欢迎入场留给后续的新会话。
		if (sessionReady) startup.seen.add("welcome");
		for (const region of sidebars) {
			if (startup.seen.has(region.name)) continue;
			const target = element.querySelector<HTMLElement>(region.selector);
			if (!target) continue;
			startup.seen.add(region.name);
			if (target.closest('[data-open="false"]')) continue;
			target.dataset.startup = region.name;
			target.style.setProperty("--startup-duration", `${startupSidebarDuration}ms`);
			startup.active.add(target);
			if (region.name === "left") {
				startup.sidebarEndsAt = performance.now() + startupSidebarDuration;
				startup.lists = startupLists(target);
			}
		}
		if (startup.seen.has("welcome")) startup.lists?.start(Math.max(performance.now(), startup.sidebarEndsAt));
	});
	return { time, enterWelcome, composer: { ref: composerRef, style: { opacity, y } } };
}
