import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { HTMLMotionProps } from "motion/react";
import { fade, motionEase, listDepth } from "@/ui/motion/transitions.ts";
import { sectionFade, sectionsDuration, startupListTiming } from "./welcome-timing.ts";

type StartupSide = "left" | "right";
type StartupList = "sessions" | "files" | "changes";
export type StartupRegion = StartupSide | StartupList;

export interface StartupLists {
	rows: ReadonlyMap<string, number>;
	finish: () => void;
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
	const [animated, setAnimated] = useState(() => takeEntrance(entrance, side));
	const [narrow] = useState(() => matchMedia("(max-width: 64em)").matches);
	const transform = side === "right" && narrow ? "translateY(12px)" : `translateX(${side === "left" ? -20 : 20}px)`;
	const animation: Pick<HTMLMotionProps<"div">, "initial" | "animate" | "transition"> = {
		initial: animated ? { opacity: 0, transform } : false,
		animate: animated ? { opacity: [0, 1], transform: [transform, "none"] } : { opacity: 1, transform: "none" },
		transition: animated ? {
			transform: { duration: sectionsDuration, ease: motionEase },
			opacity: { duration: sectionFade, ease: motionEase },
		} : { duration: 0 },
	};
	return { animation, interaction: entranceInteraction(() => setAnimated(false)) };
}

/** 只编排首次就绪的已挂载行，后续新增或滚动挂载的行不补播。 */
export function useStartupLists(region: StartupList, ready: boolean, keys: readonly string[], root: RefObject<HTMLElement | null>) {
	const entrance = useContext(StartupEntranceContext);
	const [rows, setRows] = useState<ReadonlyMap<string, number> | null>();
	if (rows === undefined && ready && keys.length) setRows(takeEntrance(entrance, region) ? new Map(keys.map((key, index) => [key, index])) : null);
	const finish = useCallback(() => setRows((current) => current === undefined ? current : null), []);
	useLayoutEffect(() => {
		if (!rows) return;
		const scroll = root.current?.closest("[data-list-scroll]");
		scroll?.addEventListener("scroll", finish, { passive: true });
		return () => scroll?.removeEventListener("scroll", finish);
	}, [rows, root, finish]);
	const lists = useMemo<StartupLists | null>(() => rows ? { rows, finish } : null, [rows, finish]);
	return { lists, ...entranceInteraction(finish) };
}

type RowEntrance = Pick<HTMLMotionProps<"div">, "initial" | "animate" | "transition" | "onAnimationComplete">;

/** 每行从挂载时开始错峰，最后一行完成后结束本批入场。 */
export function startupRow(lists: StartupLists | null, key: string, timing = startupListTiming): RowEntrance | null {
	const index = lists?.rows.get(key);
	if (!lists || index === undefined) return null;
	const duration = lists.rows.size === 1 ? timing.singleRow : timing.row;
	return {
		initial: entryHidden,
		animate: entryAnimation,
		transition: { ...listDepth.transition, duration, delay: index * timing.stagger },
		...(index === lists.rows.size - 1 ? { onAnimationComplete: lists.finish } : {}),
	};
}
