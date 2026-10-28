import { AnimatePresence, motion } from "motion/react";
import { motionDuration, settle } from "./transitions.ts";

export function AnimatedBackground({ active, layoutId }: { active: boolean; layoutId: string }) {
	return <AnimatePresence initial={false}>{active && <motion.span aria-hidden="true" className="animated-background"
		layoutId={layoutId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
		transition={{ ...settle, opacity: { duration: motionDuration[1] } }} />}</AnimatePresence>;
}
