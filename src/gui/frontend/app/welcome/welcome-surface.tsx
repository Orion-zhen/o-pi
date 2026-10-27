import { useLayoutEffect, type ReactNode } from "react";
import { motion, useIsPresent, useTransform, type MotionValue } from "motion/react";
import { WelcomeMark } from "./welcome-mark.tsx";
import { welcomeContentDuration, welcomeContentStart } from "./welcome-timing.ts";
import "./welcome-surface.css";

export function WelcomeSurface({ children, time, enterWelcome }: {
	children: ReactNode; time: MotionValue<number>; enterWelcome: () => (() => void) | undefined;
}) {
	const present = useIsPresent();
	useLayoutEffect(() => { if (present) return enterWelcome(); }, [present, enterWelcome]);
	const opacity = useTransform(time, [welcomeContentStart, welcomeContentStart + welcomeContentDuration], [0, 1]);
	const y = useTransform(opacity, [0, 1], [12, 0]);
	return <div className="welcome-surface">
		<WelcomeMark time={time} />
		<motion.div className="welcome-content" style={{ opacity, y }}>{children}</motion.div>
	</div>;
}
