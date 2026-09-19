import type { ActivityState } from "./use-session-activity.ts";
import "./activity-border.css";

const trail = Array.from({ length: 16 }, (_, index) => (index + 1) * 1.25);

/** 短线段的前端对齐叠出深色，尾部渐隐，按周长匀速移动。 */
export function ActivityBorder({ state }: { state: ActivityState }) {
	return <svg className="activity-border size-full" data-activity={state} aria-hidden="true" focusable="false">
		{trail.map((length) => <rect key={length} x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)"
			pathLength="100" strokeDasharray={`0 ${100 - length} ${length} 0`} />)}
	</svg>;
}
