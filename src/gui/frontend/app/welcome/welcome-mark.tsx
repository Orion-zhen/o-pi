import { useEffect } from "react";
import { motion, useAnimationControls } from "motion/react";
import { settle } from "@/ui/motion/transitions.ts";
import { useAnimationVisibility } from "@/ui/motion/use-animation-visibility.ts";

const resting = { y: 0, scaleY: 1, rotate: 0 };

export function WelcomeMark() {
	const { ref, playing } = useAnimationVisibility<HTMLSpanElement>({ requireFocus: true });
	const animation = useAnimationControls();
	useEffect(() => {
		if (!playing) { animation.set(resting); return; }
		let timer: number;
		let stretching = false;
		const schedule = (delay: number) => { window.clearTimeout(timer); timer = window.setTimeout(play, delay); };
		const play = () => {
			stretching = true;
			void animation.start({ y: [0, 1, -5, -5, 0], scaleY: [1, 0.96, 1.08, 1.08, 1], rotate: [0, 0, -4, -4, 0],
				transition: { duration: 3.2, times: [0, 0.16, 0.55, 0.68, 1], ease: "easeInOut" },
			}).then(() => { stretching = false; });
			schedule(20_000 + Math.random() * 10_000);
		};
		const activity = () => {
			if (stretching) {
				stretching = false;
				void animation.start({ ...resting, transition: settle });
			}
			schedule(5_000);
		};
		const events = ["pointerdown", "keydown", "input", "wheel"] as const;
		for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
		schedule(5_000);
		return () => {
			window.clearTimeout(timer);
			animation.stop();
			for (const event of events) window.removeEventListener(event, activity, true);
		};
	}, [playing, animation]);

	return <div className="welcome-mark"><motion.span ref={ref} animate={animation} className="app-logo" role="img" aria-label="opi" /></div>;
}
