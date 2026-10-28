import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, cubicBezier, useMotionValue, useTransform } from "motion/react";
import { fade, feedback, motionEase } from "@/ui/motion/transitions.ts";
import type { StartupLists, StartupSide } from "./startup-entrance.tsx";
import { listWindow, sectionsDuration, welcomeComposerFadeDuration, welcomeContentDuration, welcomeContentStart, welcomeDuration } from "./welcome-timing.ts";

const composerEase = cubicBezier(...motionEase);

/** 入场在 App 内只消费一次，各区域通过挂载回调参与。 */
export function useStartupMotion(showWelcome: boolean, sessionReady: boolean) {
	const time = useMotionValue(welcomeDuration);
	const opacity = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeComposerFadeDuration], [0, 1], { ease: composerEase });
	const y = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeContentDuration], [12, 0], { ease: composerEase });
	const state = useRef({
		seen: new Set<StartupSide | "welcome" | "composer">(),
		stopped: false, revealed: false,
		sectionsEndAt: performance.now() + sectionsDuration * 1000,
	});
	const [lists, setLists] = useState<StartupLists | null>({ startAt: null });
	const timer = useRef<number>(undefined);
	const finishWelcome = useCallback(() => time.jump(welcomeDuration), [time]);
	const finishComposer = useCallback(() => { opacity.jump(1); y.jump(0); }, [opacity, y]);
	// 列表行在欢迎页落定后入场，不早于侧栏内容入场结束。
	const revealLists = useCallback(() => {
		const startup = state.current;
		if (startup.stopped || startup.revealed) return;
		startup.revealed = true;
		const startAt = Math.max(performance.now(), startup.sectionsEndAt);
		setLists({ startAt });
		timer.current = window.setTimeout(() => setLists(null), startAt + listWindow * 1000 - performance.now());
	}, []);
	const takeSection = useCallback((side: StartupSide) => {
		const startup = state.current;
		if (startup.stopped || startup.seen.has(side)) return false;
		startup.seen.add(side);
		return true;
	}, []);
	const enterWelcome = useCallback(() => {
		const startup = state.current;
		if (startup.stopped || startup.seen.has("welcome")) return;
		startup.seen.add("welcome");
		time.set(0);
		animate(time, welcomeDuration, { duration: welcomeDuration, ease: "linear" });
		revealLists();
		return finishWelcome;
	}, [time, finishWelcome, revealLists]);
	const composerRef = useCallback((element: HTMLElement | null) => {
		const startup = state.current;
		if (!element || startup.stopped || startup.seen.has("composer")) return;
		startup.seen.add("composer");
		// 欢迎页即将或正在入场时共享时间，其余首次挂载只播放短入场。
		if (time.get() >= welcomeDuration && (!showWelcome || startup.seen.has("welcome"))) {
			animate(opacity, [0, 1], fade.transition);
			animate(y, [12, 0], feedback);
		}
		return finishComposer;
	}, [time, opacity, y, finishComposer, showWelcome]);

	useLayoutEffect(() => {
		const startup = state.current;
		const stop = () => {
			if (startup.stopped) return;
			startup.stopped = true;
			finishWelcome();
			finishComposer();
			setLists(null);
		};
		const events = ["pointerdown", "keydown", "wheel", "resize"] as const;
		for (const event of events) window.addEventListener(event, stop, { capture: true, passive: true });
		return () => {
			for (const event of events) window.removeEventListener(event, stop, true);
			window.clearTimeout(timer.current);
		};
	}, [finishWelcome, finishComposer]);

	useLayoutEffect(() => {
		const startup = state.current;
		if (startup.stopped || !sessionReady || showWelcome) return;
		// 首次恢复历史会话也消费入场资格，不依赖子组件的副作用执行顺序。
		startup.seen.add("welcome");
		revealLists();
	}, [sessionReady, showWelcome, revealLists]);

	const entrance = useMemo(() => ({ lists, takeSection }), [lists, takeSection]);
	return { time, enterWelcome, entrance, composer: { ref: composerRef, style: { opacity, y } } };
}
