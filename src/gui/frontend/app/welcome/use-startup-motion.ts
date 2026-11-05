import { useCallback, useLayoutEffect, useRef } from "react";
import { animate, cubicBezier, useMotionValue, useTransform } from "motion/react";
import { fade, feedback, motionEase } from "@/ui/motion/transitions.ts";
import { entranceInteraction } from "./startup-entrance.tsx";
import { welcomeComposerFadeDuration, welcomeContentDuration, welcomeContentStart, welcomeDuration } from "./welcome-timing.ts";

const composerEase = cubicBezier(...motionEase);

/** 欢迎页与输入器共享主区入场，每个组件只播放一次。 */
export function useStartupMotion(showWelcome: boolean, sessionReady: boolean) {
	const time = useMotionValue(welcomeDuration);
	const opacity = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeComposerFadeDuration], [0, 1], { ease: composerEase });
	const y = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeContentDuration], [12, 0], { ease: composerEase });
	const seen = useRef(new Set<"welcome" | "composer">());
	const finishWelcome = useCallback(() => time.jump(welcomeDuration), [time]);
	const finishComposer = useCallback(() => { opacity.jump(1); y.jump(0); }, [opacity, y]);
	const enterWelcome = useCallback(() => {
		if (seen.current.has("welcome")) return;
		seen.current.add("welcome");
		time.set(0);
		animate(time, welcomeDuration, { duration: welcomeDuration, ease: "linear" });
		return finishWelcome;
	}, [time, finishWelcome]);
	const composerRef = useCallback((element: HTMLElement | null) => {
		if (!element || seen.current.has("composer")) return;
		seen.current.add("composer");
		// 欢迎页即将或正在入场时共享时间，其余首次挂载只播放短入场。
		if (time.get() >= welcomeDuration && (!showWelcome || seen.current.has("welcome"))) {
			animate(opacity, [0, 1], fade.transition);
			animate(y, [12, 0], feedback);
		}
		return finishComposer;
	}, [time, opacity, y, finishComposer, showWelcome]);

	useLayoutEffect(() => {
		if (!sessionReady || showWelcome) return;
		// 首次恢复历史会话也消费入场资格，不依赖子组件的副作用执行顺序。
		seen.current.add("welcome");
	}, [sessionReady, showWelcome]);

	return {
		time, enterWelcome,
		interaction: entranceInteraction(() => { finishWelcome(); finishComposer(); }),
		composer: { ref: composerRef, style: { opacity, y } },
	};
}
