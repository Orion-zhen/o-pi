import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

export function useAnimationVisibility<T extends Element>({ requireFocus = false }: { requireFocus?: boolean } = {}) {
	const ref = useRef<T>(null);
	const visible = useInView(ref);
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		const update = () => setAvailable(!document.hidden && (!requireFocus || document.hasFocus()));
		update();
		if (requireFocus) {
			window.addEventListener("focus", update);
			window.addEventListener("blur", update);
		}
		document.addEventListener("visibilitychange", update);
		return () => {
			if (requireFocus) {
				window.removeEventListener("focus", update);
				window.removeEventListener("blur", update);
			}
			document.removeEventListener("visibilitychange", update);
		};
	}, [requireFocus]);
	return { ref, playing: visible && available };
}
