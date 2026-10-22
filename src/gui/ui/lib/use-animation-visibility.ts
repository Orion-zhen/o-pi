import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

export function useAnimationVisibility<T extends Element>() {
	const ref = useRef<T>(null);
	const visible = useInView(ref);
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		const update = () => setAvailable(!document.hidden && document.hasFocus());
		update();
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		document.addEventListener("visibilitychange", update);
		return () => {
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
			document.removeEventListener("visibilitychange", update);
		};
	}, []);
	return { ref, playing: visible && available };
}
