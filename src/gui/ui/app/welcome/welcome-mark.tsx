import { useEffect, useRef } from "react";

const stretch: Keyframe[] = [
	{ transform: "translateY(0px) scaleY(1) rotate(0deg)", offset: 0, easing: "ease-in-out" },
	{ transform: "translateY(1px) scaleY(0.96) rotate(0deg)", offset: 0.16, easing: "ease-in-out" },
	{ transform: "translateY(-5px) scaleY(1.08) rotate(-4deg)", offset: 0.55, easing: "ease-in-out" },
	{ transform: "translateY(-5px) scaleY(1.08) rotate(-4deg)", offset: 0.68, easing: "ease-in-out" },
	{ transform: "translateY(0px) scaleY(1) rotate(0deg)", offset: 1 },
];

export function WelcomeMark() {
	const logo = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const element = logo.current;
		if (!element) return;
		let timer: number | undefined;
		let animation: Animation | undefined;
		let stretching = false;
		const canPlay = () => !document.hidden && document.hasFocus();
		const stop = () => { animation?.cancel(); animation = undefined; stretching = false; };
		const animate = (frames: Keyframe[], options: KeyframeAnimationOptions) => {
			animation?.cancel();
			const current = element.animate(frames, options);
			animation = current;
			current.onfinish = () => { if (animation === current) stop(); };
		};
		const schedule = (delay: number) => {
			window.clearTimeout(timer);
			if (canPlay()) timer = window.setTimeout(play, delay);
		};
		const play = () => {
			if (!canPlay()) return;
			stretching = true;
			animate(stretch, { duration: 3200 });
			schedule(20_000 + Math.random() * 10_000);
		};
		const activity = () => {
			if (stretching) {
				const transform = getComputedStyle(element).transform;
				stretching = false;
				animate([{ transform }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
			}
			schedule(5_000);
		};
		const availabilityChanged = () => { stop(); schedule(5_000); };
		const events = ["pointerdown", "keydown", "input", "wheel"] as const;
		for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
		window.addEventListener("focus", availabilityChanged);
		window.addEventListener("blur", availabilityChanged);
		document.addEventListener("visibilitychange", availabilityChanged);
		availabilityChanged();
		return () => {
			window.clearTimeout(timer);
			stop();
			for (const event of events) window.removeEventListener(event, activity, true);
			window.removeEventListener("focus", availabilityChanged);
			window.removeEventListener("blur", availabilityChanged);
			document.removeEventListener("visibilitychange", availabilityChanged);
		};
	}, []);

	return <div className="welcome-mark">
		<span ref={logo} className="app-logo" role="img" aria-label="opi" />
	</div>;
}
