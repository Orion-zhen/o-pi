import { useCallback, useLayoutEffect, useRef } from "react";
import { animate, cubicBezier, useMotionValue, useTransform } from "motion/react";
import { feedback } from "@/ui/motion/transitions.ts";
import { startupSidebar } from "./startup-sidebar.ts";
import { welcomeComposerFadeDuration, welcomeContentDuration, welcomeContentStart, welcomeDuration } from "./welcome-timing.ts";
import "./startup-motion.css";

const composerEase = cubicBezier(...feedback.ease);

/** 入场在 App 内只消费一次，各区域通过挂载回调参与。 */
export function useStartupMotion(showWelcome: boolean, sessionReady: boolean) {
	const time = useMotionValue(welcomeDuration);
	const opacity = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeComposerFadeDuration], [0, 1], { ease: composerEase });
	const y = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeContentDuration], [12, 0], { ease: composerEase });
	const state = useRef({
		seen: new Set<"left" | "right" | "welcome" | "composer">(),
		sidebars: new Set<ReturnType<typeof startupSidebar>>(), stopped: false,
	});
	const finishWelcome = useCallback(() => time.jump(welcomeDuration), [time]);
	const finishComposer = useCallback(() => { opacity.jump(1); y.jump(0); }, [opacity, y]);
	const enterWelcome = useCallback(() => {
		const startup = state.current;
		if (startup.stopped || startup.seen.has("welcome")) return;
		startup.seen.add("welcome");
		time.set(0);
		animate(time, welcomeDuration, { duration: welcomeDuration, ease: "linear" });
		for (const sidebar of startup.sidebars) sidebar.ready();
		return finishWelcome;
	}, [time, finishWelcome]);
	const composerRef = useCallback((element: HTMLElement | null) => {
		const startup = state.current;
		if (!element || startup.stopped || startup.seen.has("composer")) return;
		startup.seen.add("composer");
		// 欢迎页即将或正在入场时共享时间，其余首次挂载只播放短入场。
		if (time.get() >= welcomeDuration && (!showWelcome || startup.seen.has("welcome"))) {
			animate(opacity, [0, 1], { duration: 0.16, ease: feedback.ease });
			animate(y, [12, 0], { duration: 0.24, ease: feedback.ease });
		}
		return finishComposer;
	}, [time, opacity, y, finishComposer, showWelcome]);
	const enterSidebar = useCallback((element: HTMLElement | null, side: "left" | "right") => {
		const startup = state.current;
		if (!element || startup.stopped || startup.seen.has(side)) return;
		startup.seen.add(side);
		if (element.closest('[data-open="false"]')) return;
		const sidebar = startupSidebar(element, side);
		startup.sidebars.add(sidebar);
		if (startup.seen.has("welcome")) sidebar.ready();
		return () => { sidebar.stop(); startup.sidebars.delete(sidebar); };
	}, []);
	const leftSidebar = useCallback((element: HTMLElement | null) => enterSidebar(element, "left"), [enterSidebar]);
	const rightSidebar = useCallback((element: HTMLElement | null) => enterSidebar(element, "right"), [enterSidebar]);

	useLayoutEffect(() => {
		const startup = state.current;
		const stop = () => {
			if (startup.stopped) return;
			startup.stopped = true;
			finishWelcome();
			finishComposer();
			for (const sidebar of startup.sidebars) sidebar.stop();
			startup.sidebars.clear();
		};
		const events = ["pointerdown", "keydown", "wheel", "resize"] as const;
		for (const event of events) window.addEventListener(event, stop, { capture: true, passive: true });
		return () => {
			stop();
			for (const event of events) window.removeEventListener(event, stop, true);
		};
	}, [finishWelcome, finishComposer]);

	useLayoutEffect(() => {
		const startup = state.current;
		if (startup.stopped || !sessionReady || showWelcome) return;
		// 首次恢复历史会话也消费入场资格，不依赖子组件的副作用执行顺序。
		startup.seen.add("welcome");
		for (const sidebar of startup.sidebars) sidebar.ready();
	}, [sessionReady, showWelcome]);
	return { time, enterWelcome, leftSidebar, rightSidebar, composer: { ref: composerRef, style: { opacity, y } } };
}
