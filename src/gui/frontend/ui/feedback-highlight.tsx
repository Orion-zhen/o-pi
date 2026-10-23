import { useState } from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import { feedback } from "./motion/transitions.ts";

export function FeedbackHighlight(props: Pick<HTMLMotionProps<"span">, "style">) {
	const [visible, setVisible] = useState(true);
	return visible ? <motion.span {...props} aria-hidden="true" className="feedback-highlight"
		initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }}
		transition={{ ...feedback, duration: 1.6, times: [0, 0.125, 0.375, 1] }}
		onAnimationComplete={() => setVisible(false)} /> : null;
}
