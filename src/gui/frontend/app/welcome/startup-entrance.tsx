import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";
import { animate, useMotionValue, useTransform, type HTMLMotionProps } from "motion/react";
import { fade, motionEase, listDepth } from "@/ui/motion/transitions.ts";
import { sectionFade, sectionsDuration, startupListTiming } from "./welcome-timing.ts";

type StartupSide = "left" | "right";
type StartupList = "sessions" | "files" | "changes";
export type StartupRegion = StartupSide | StartupList;

export interface StartupLists {
	startAt: number;
}

export const StartupEntranceContext = createContext<Set<StartupRegion> | null>(null);

function takeEntrance(entrance: Set<StartupRegion> | null, region: StartupRegion): boolean {
	if (!entrance || entrance.has(region)) return false;
	entrance.add(region);
	return true;
}

export function entranceInteraction(finish: () => void) {
	return { onPointerDownCapture: finish, onKeyDownCapture: finish, onWheelCapture: finish };
}

const entryHidden = { ...fade.initial, ...listDepth.hidden };
const entryVisible = { ...fade.animate, ...listDepth.visible };
const entryAnimation = {
	opacity: [entryHidden.opacity, entryVisible.opacity],
	transform: [entryHidden.transform, entryVisible.transform],
	filter: [entryHidden.filter, entryVisible.filter],
};

/** 侧栏内部元素的入场。侧栏外壳（背景、分隔条）已经展开，保持静止。 */
export function useSectionEntrance(side: StartupSide) {
	const entrance = useContext(StartupEntranceContext);
	const [animated] = useState(() => takeEntrance(entrance, side));
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
	return { style: { opacity, x, y }, ...entranceInteraction(() => { shift.jump(1); opacity.jump(1); }) };
}

/** 列表首次就绪时开始计时，不受其他区域的入场或交互影响。 */
export function useStartupLists(region: StartupList, ready: boolean, timing = startupListTiming) {
	const entrance = useContext(StartupEntranceContext);
	const [lists, setLists] = useState<StartupLists | null>();
	if (lists === undefined && ready) setLists(takeEntrance(entrance, region) ? { startAt: performance.now() } : null);
	const finish = useCallback(() => setLists((current) => current === undefined ? current : null), []);
	useLayoutEffect(() => {
		if (!lists) return;
		const timer = window.setTimeout(finish, lists.startAt + timing.window * 1000 - performance.now());
		return () => window.clearTimeout(timer);
	}, [lists, timing, finish]);
	return { lists: lists ?? null, ...entranceInteraction(finish) };
}

type RowEntrance = Pick<HTMLMotionProps<"div">, "initial" | "animate" | "transition">;

/** 列表行的入场属性，null 表示按普通出现。 */
export function startupRow(lists: StartupLists | null, index: number, count: number, timing = startupListTiming): RowEntrance | null {
	if (!lists) return null;
	const duration = count === 1 ? timing.singleRow : timing.row;
	const stagger = count > 1 ? (timing.window - duration) / (count - 1) : 0;
	// 新挂载的虚拟行接上本列表的进度，不重新播放整段入场。
	const delay = (lists.startAt - performance.now()) / 1000 + index * stagger;
	return {
		initial: entryHidden,
		animate: entryAnimation,
		transition: { ...listDepth.transition, duration, delay },
	};
}
