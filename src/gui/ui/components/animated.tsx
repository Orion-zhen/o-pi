import { motion, useIsPresent, type HTMLMotionProps } from "motion/react";
import { fade, settle } from "../lib/motion";

export function Fade(props: HTMLMotionProps<"div">) {
	const present = useIsPresent();
	return <motion.div {...fade} {...props} inert={!present || props.inert} aria-hidden={present ? props["aria-hidden"] : true} />;
}

export function ListItem(props: HTMLMotionProps<"li">) {
	const present = useIsPresent();
	return <motion.li {...fade} layout="position" transition={{ ...fade.transition, layout: settle }} inert={!present} aria-hidden={!present} {...props} />;
}

export function Reveal({ children, style, ...props }: HTMLMotionProps<"div">) {
	const present = useIsPresent();
	return <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
		exit={{ height: 0, opacity: 0 }} transition={settle} inert={!present} aria-hidden={!present}
		style={{ ...style, overflow: "clip" }} {...props}>{children}</motion.div>;
}
