import { useEffect } from "react";
import { motion, useAnimationControls } from "motion/react";
import { welcomeIdle } from "../../lib/motion.ts";

export function WelcomeMark() {
	const controls = useAnimationControls();
	useEffect(() => {
		let timer: number | undefined;
		let stretching = false;
		const canPlay = () => !document.hidden && document.hasFocus();
		const schedule = (delay: number) => {
			window.clearTimeout(timer);
			if (canPlay()) timer = window.setTimeout(play, delay);
		};
		const play = () => {
			if (!canPlay()) return;
			stretching = true;
			void controls.start("stretch");
			schedule(20_000 + Math.random() * 10_000);
		};
		const activity = () => {
			if (stretching) {
				stretching = false;
				void controls.start("rest");
			}
			schedule(5_000);
		};
		const availabilityChanged = () => {
			stretching = false;
			controls.stop();
			controls.set("rest");
			schedule(5_000);
		};
		const events = ["pointerdown", "keydown", "input", "wheel"] as const;
		for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
		window.addEventListener("focus", availabilityChanged);
		window.addEventListener("blur", availabilityChanged);
		document.addEventListener("visibilitychange", availabilityChanged);
		availabilityChanged();
		return () => {
			window.clearTimeout(timer);
			controls.stop();
			for (const event of events) window.removeEventListener(event, activity, true);
			window.removeEventListener("focus", availabilityChanged);
			window.removeEventListener("blur", availabilityChanged);
			document.removeEventListener("visibilitychange", availabilityChanged);
		};
	}, [controls]);

	return <div className="welcome-mark">
		<motion.span className="app-logo" role="img" aria-label="opi" initial={false} animate={controls} variants={welcomeIdle} />
	</div>;
}
