import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIsPresent } from "motion/react";
import { ContentVisible } from "../components/ui/collapsible";

export function useReplyAnimation<T extends HTMLElement>(active: boolean) {
	const ref = useRef<T>(null);
	const expanded = useContext(ContentVisible);
	const present = useIsPresent();
	const enabled = active && expanded && present;
	const [visible, setVisible] = useState(false);
	const playing = enabled && visible;
	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) { setVisible(false); return; }
		let intersecting = false;
		const update = () => setVisible(intersecting && !document.hidden);
		const observer = new IntersectionObserver(([entry]) => {
			intersecting = entry?.isIntersecting ?? false;
			update();
		});
		observer.observe(element);
		document.addEventListener("visibilitychange", update);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", update);
		};
	}, [enabled]);
	useLayoutEffect(() => {
		for (const animation of ref.current?.getAnimations({ subtree: true }) ?? []) {
			if (!(animation instanceof CSSAnimation) || !animation.animationName.startsWith("reply-")) continue;
			if (playing) {
				animation.play();
				// 可见元素共用页面时钟，恢复时不逐帧更新祖先样式。
				animation.startTime = 0;
			} else animation.pause();
		}
	}, [active, playing]);
	return { ref, playing };
}
