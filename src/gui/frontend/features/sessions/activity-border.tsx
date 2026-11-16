import { motion } from "motion/react";
import type { ActivityState } from "./use-session-activity.ts";
import { feedback } from "@/ui/motion/transitions.ts";
import { useAnimationVisibility } from "@/ui/motion/use-animation-visibility.ts";
import "./activity-border.css";

const trail = Array.from({ length: 16 }, (_, index) => (index + 1) * 1.25);

/** 短线段的前端对齐叠出深色，尾部渐隐，按周长匀速移动。 */
export function ActivityBorder({ state }: { state: ActivityState }) {
	const { ref, playing } = useAnimationVisibility<SVGSVGElement>();
	return <motion.svg ref={ref} className="activity-border size-full" data-activity={state} data-playing={playing} aria-hidden="true" focusable="false"
		initial={false} transition={feedback} animate={{
			opacity: state === "idle" ? 0 : state === "running" ? 0.75 : state === "unread" ? [0.75, 1, 0.7] : 0.7,
		}}>
		{trail.map((length) => {
			const gap = state === "running" ? 100 - length : 0;
			const dash = 100 - gap;
			return <motion.rect key={length} x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)"
				pathLength="100" initial={false} transition={feedback} animate={{ strokeDasharray: `0 ${gap} ${dash} 0` }} />;
		})}
	</motion.svg>;
}
