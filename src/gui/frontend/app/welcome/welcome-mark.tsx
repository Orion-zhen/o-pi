import { useEffect, useState } from "react";
import { animate, useMotionValue, useMotionValueEvent, type MotionValue } from "motion/react";
import { settle } from "@/ui/motion/transitions.ts";
import { useAnimationVisibility } from "@/ui/motion/use-animation-visibility.ts";
import { WelcomeIllustration } from "./welcome-illustration.tsx";
import { welcomeLogoStart } from "./welcome-timing.ts";

export function WelcomeMark({ time }: { time: MotionValue<number> }) {
	const { ref, playing } = useAnimationVisibility<HTMLDivElement>({ requireFocus: true });
	const pose = useMotionValue(0);
	const [complete, setComplete] = useState(time.get() >= welcomeLogoStart);
	useMotionValueEvent(time, "change", (value) => setComplete(value >= welcomeLogoStart));
	useEffect(() => {
		if (!playing || !complete) { pose.set(0); return; }
		let timer: number;
		const schedule = (delay: number) => { window.clearTimeout(timer); timer = window.setTimeout(play, delay); };
		const play = () => {
			animate(pose, [0, 1, 1, 0], {
				duration: 3.2, times: [0, 0.4, 0.58, 1], ease: [0.3, 0, 0.3, 1],
			});
			schedule(18_000);
		};
		const activity = () => {
			pose.stop();
			if (pose.get() !== 0) animate(pose, 0, settle);
			schedule(5_000);
		};
		const events = ["pointerdown", "keydown", "input", "wheel"] as const;
		for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
		schedule(5_000);
		return () => {
			window.clearTimeout(timer);
			pose.stop();
			for (const event of events) window.removeEventListener(event, activity, true);
		};
	}, [playing, complete, pose]);

	return <div className="welcome-mark" ref={ref}><WelcomeIllustration time={time} pose={pose} complete={complete} /></div>;
}
