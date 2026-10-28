import { createContext, useContext, useLayoutEffect, useState } from "react";
import { animate, useMotionValue, useTransform, type HTMLMotionProps, type MotionStyle } from "motion/react";
import { fade, motionEase, listDepth } from "@/ui/motion/transitions.ts";
import { sectionFade, sectionsDuration, startupListTiming } from "./welcome-timing.ts";

export type StartupSide = "left" | "right";

export interface StartupLists {
	/** 列表入场开始的 performance.now()；null 表示等待欢迎页入场。 */
	startAt: number | null;
}

interface StartupEntrance {
	/** null 表示不参与入场（尚未开始或已结束）。 */
	lists: StartupLists | null;
	/** 侧栏内容首次挂载时返回 true。 */
	takeSection: (side: StartupSide) => boolean;
}

export const StartupEntranceContext = createContext<StartupEntrance | null>(null);

const entryHidden = { ...fade.initial, ...listDepth.hidden };
const entryVisible = { ...fade.animate, ...listDepth.visible };

/** 侧栏内部元素的入场。侧栏外壳（背景、分隔条）已经展开，保持静止。 */
export function useSectionEntrance(side: StartupSide): MotionStyle | undefined {
	const entrance = useContext(StartupEntranceContext);
	const [animated] = useState(() => entrance?.takeSection(side) ?? false);
	const [narrow] = useState(() => matchMedia("(max-width: 64em)").matches);
	const shift = useMotionValue(animated ? 0 : 1);
	const opacity = useMotionValue(animated ? 0 : 1);
	const vertical = side === "right" && narrow;
	const x = useTransform(shift, [0, 1], [vertical ? 0 : side === "left" ? -20 : 20, 0]);
	const y = useTransform(shift, [0, 1], [vertical ? 12 : 0, 0]);
	useLayoutEffect(() => {
		if (!animated) return;
		const animations = [
			animate(shift, 1, { duration: sectionsDuration, ease: motionEase }),
			animate(opacity, 1, { duration: sectionFade, ease: motionEase }),
		];
		return () => { for (const animation of animations) animation.stop(); };
	}, [animated, shift, opacity]);
	return { opacity, x, y };
}

export function useStartupLists(): StartupLists | null {
	return useContext(StartupEntranceContext)?.lists ?? null;
}

type RowEntrance = Pick<HTMLMotionProps<"div">, "initial" | "animate" | "transition" | "style">;

/** 列表行的入场属性；null 表示按普通出现。 */
export function startupRow(lists: StartupLists | null, index: number, count: number, timing = startupListTiming): RowEntrance | null {
	if (!lists) return null;
	const { startAt } = lists;
	const duration = count === 1 ? timing.singleRow : timing.row;
	const stagger = count > 1 ? (timing.window - duration) / (count - 1) : 0;
	const delay = startAt === null ? 0 : Math.max(0, (startAt - performance.now()) / 1000) + index * stagger;
	return {
		initial: entryHidden,
		animate: startAt === null ? entryHidden : entryVisible,
		transition: { ...listDepth.transition, duration, delay },
		// 等待入场期间不可见也不可交互，与旧实现的 visibility: hidden 一致。
		style: { visibility: startAt === null ? "hidden" : "visible" },
	};
}
