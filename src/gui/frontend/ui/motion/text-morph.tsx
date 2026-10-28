import { useMemo } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { fade, settle } from "./transitions.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function TextMorph({ children, transition = { ...fade.transition, layout: settle } }: { children: string; transition?: Transition }) {
	const characters = useMemo(() => {
		const counts = new Map<string, number>();
		return [...segmenter.segment(children)].map(({ segment }) => {
			const count = (counts.get(segment) ?? 0) + 1;
			counts.set(segment, count);
			return { key: `${segment}-${count}`, text: segment };
		});
	}, [children]);
	return <span className="text-morph">
		<span className="sr-only">{children}</span>
		<span aria-hidden="true"><AnimatePresence initial={false} mode="popLayout">{characters.map(({ key, text }) =>
			<motion.span key={key} layout className="text-morph-character" {...fade}
				transition={transition}>{text}</motion.span>,
		)}</AnimatePresence></span>
	</span>;
}
