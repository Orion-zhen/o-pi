import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

export function useAnimationVisibility<T extends Element>() {
	const ref = useRef<T>(null);
	const visible = useInView(ref);
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		const update = () => setAvailable(!document.hidden);
		update();
		document.addEventListener("visibilitychange", update);
		return () => {
			document.removeEventListener("visibilitychange", update);
		};
	}, []);
	return { ref, playing: visible && available };
}
