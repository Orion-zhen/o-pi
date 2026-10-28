import type { ReactNode, Ref } from "react";
import { AnimatePresence, motion, useIsPresent, type HTMLMotionProps } from "motion/react";
import { fade, settle } from "./transitions.ts";

export function Fade(props: HTMLMotionProps<"div">) {
	const present = useIsPresent();
	return <motion.div {...fade} {...props} inert={!present || props.inert} aria-hidden={present ? props["aria-hidden"] : true} />;
}

export function Crossfade({ value, children }: { value: string; children: ReactNode }) {
	return <motion.span className="crossfade" layout="size" layoutDependency={value} transition={settle}>
		<AnimatePresence initial={false} mode="popLayout"><CrossfadeContent key={value}>{children}</CrossfadeContent></AnimatePresence>
	</motion.span>;
}

function CrossfadeContent({ ref, children }: { ref?: Ref<HTMLSpanElement>; children: ReactNode }) {
	const present = useIsPresent();
	return <motion.span ref={ref} {...fade} className="crossfade-content" layout="position"
		transition={{ ...fade.transition, layout: settle }} inert={!present} aria-hidden={!present}>{children}</motion.span>;
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
