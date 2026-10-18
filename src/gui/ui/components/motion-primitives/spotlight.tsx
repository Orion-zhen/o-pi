import { useEffect, useRef, useState } from "react";
import { motion, useSpring } from "motion/react";

export function Spotlight() {
	const ref = useRef<HTMLSpanElement>(null);
	const [hovered, setHovered] = useState(false);
	const x = useSpring(0, { stiffness: 250, damping: 35 });
	const y = useSpring(0, { stiffness: 250, damping: 35 });
	useEffect(() => {
		const parent = ref.current?.parentElement;
		if (!parent) return;
		const controller = new AbortController();
		const options = { signal: controller.signal };
		const move = (event: PointerEvent) => {
			if (event.pointerType !== "mouse") return;
			const bounds = parent.getBoundingClientRect();
			const nextX = event.clientX - bounds.left;
			const nextY = event.clientY - bounds.top;
			if (event.type === "pointerenter") { x.jump(nextX); y.jump(nextY); }
			else { x.set(nextX); y.set(nextY); }
			setHovered(true);
		};
		const stop = () => { setHovered(false); x.stop(); y.stop(); };
		parent.addEventListener("pointerenter", move, options);
		parent.addEventListener("pointermove", move, options);
		parent.addEventListener("pointerleave", stop, options);
		window.addEventListener("blur", stop, options);
		document.addEventListener("visibilitychange", stop, options);
		return () => { controller.abort(); x.stop(); y.stop(); };
	}, [x, y]);
	return <motion.span ref={ref} aria-hidden="true" className="spotlight" data-hovered={hovered} style={{ x, y }} />;
}
